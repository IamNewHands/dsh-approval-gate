/**
 * 「追认」端点（POST /api/auto-approve/reconsider）回归测试。
 *
 * 需求来源（2026-09-16）：判定层静默拒绝的请求此前只能在审批 tab 里看到，
 * 且没有任何补救手段。本测试锁定三条契约：
 *   1. 只有**判定层静默拒绝**（judge-deny）可追认；确定性硬拒档
 *      （hard-reject：凭据外泄 / 根与系统路径销毁）位于管道最前，白名单盖不过它，
 *      给按钮就是假承诺 → 必须 400 拒绝。
 *   2. 硬风险类别属于「必须人工确认」，不接受追认式自动放行 → 400。
 *   3. 可追认时：写入带操作指纹的 allowRules、投递重试指令、写一条
 *      kind='reconsidered' 且带 reconsiderOf 的记录；事件 API 据此把原事件
 *      标注 reconsidered:true 并过滤掉追认记录本身。
 *
 * 全部断言针对 src/index.mjs 的**真实实现**（模拟宿主执行注册的 HTTP 处理器），
 * 用临时 DSH_HOME 隔离，绝不触碰真实 ~/.dsh/auto-approve。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-reconsider-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
mkdirSync(dataDir, { recursive: true })
const WORKSPACE = join(tempHome, 'ws')
mkdirSync(WORKSPACE, { recursive: true })

const EVENTS_PATH = join(dataDir, 'events.jsonl')
const CONFIG_PATH = join(dataDir, 'allowlist.json')

writeFileSync(CONFIG_PATH, JSON.stringify({
  version: 4,
  denyKeywords: [],
  allowRules: [],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 2,
  judgeTimeoutMs: 300,
  learning: { enabled: true },
}, null, 2) + '\n', 'utf8')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const plugin = (await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())).default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing reconsider endpoint...')

// ================= 模拟宿主（只暴露 HTTP 路由） =================
function makeCtx() {
  const state = { routes: new Map(), delivered: [] }
  const ctx = {
    llm: { stream: () => { throw new Error('judge must not be called in this test') } },
    permissionPresets: { current: () => 'auto-approve' },
    get: (key) => (key === 'agents'
      ? { get: (sid) => ({ followup: (msg) => { state.delivered.push({ sid, text: msg.content[0].text }) } }) }
      : undefined),
    webServer: { register: (spec) => { state.routes.set(spec.path, spec); return () => {} } },
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    on: () => () => {},
  }
  return { ctx, state }
}

/** 极简 req/res：readBody 依赖 req.on('data'|'end'|'error') */
function fakeReq(method, body) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method,
    url: '/api/auto-approve/reconsider',
    headers: {},
    on: (ev, fn) => { if (listeners[ev]) listeners[ev].push(fn) },
  }
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.data) fn(JSON.stringify(body))
    for (const fn of listeners.end) fn()
  })
  return req
}

function fakeRes() {
  const res = { status: 0, payload: null }
  res.writeHead = (code) => { res.status = code }
  res.end = (text) => { try { res.payload = JSON.parse(text) } catch { res.payload = text } }
  return res
}

async function call(state, path, method, body) {
  const route = state.routes.get(path)
  assert.ok(route, `route ${path} must be registered`)
  const res = fakeRes()
  await route.handler(fakeReq(method, body), res)
  return res
}

/** 追加一条事件到 events.jsonl（events 文件是追加式日志，绝不覆盖历史） */
function seedEvent(ev) {
  appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n', 'utf8')
}

const { ctx, state } = makeCtx()
plugin.apply(ctx)

// 启动时会把仓库种子的共享规则并入本地配置（多机同步），因此断言一律以
// 这个基线为参照，只关心「追认是否新增/重复写了规则」。
const BASELINE_RULES = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).allowRules.length
const ruleCount = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).allowRules.length

// ================= 1. 路由已注册 =================
{
  for (const p of ['/api/auto-approve/reconsider', '/api/auto-approve/events']) {
    assert.ok(state.routes.has(p), `route ${p} must be registered`)
  }
  console.log('  ✓ 追认与事件路由已注册')
}

// ================= 2. 硬拒档不可追认 =================
{
  seedEvent({
    id: 1, ts: '2026-09-16T13:13:25.291Z', sessionId: 's1', tool: 'edit',
    mode: 'danger-full-access', reason: 'r', justification: 'Merge.yaml 在工作区之外',
    verdict: 'hard-reject', kind: 'hard-reject', path: 'hard-deny', category: 'credential',
    files: ['Merge.yaml'],
  })
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { sessionId: 's1', eventId: 1 })
  assert.strictEqual(res.status, 400, 'hard-reject must not be reconsiderable')
  assert.ok(/不可追认/.test(res.payload.error), 'error must explain why')
  assert.strictEqual(ruleCount(), BASELINE_RULES, 'a rejected reconsider must write no rule')
  console.log('  ✓ 硬拒档不可追认（400，不写规则）')
}

// ================= 3. 硬风险类别的 judge-deny 不可追认 =================
{
  seedEvent({
    id: 2, ts: '2026-09-16T13:13:25.291Z', sessionId: 's1', tool: 'edit',
    mode: 'danger-full-access', reason: 'r', justification: 'Merge.yaml 在工作区之外',
    verdict: 'judge-deny', kind: 'judge-deny', path: 'classifier-deny', category: 'system',
    files: ['Merge.yaml'],
  })
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { sessionId: 's1', eventId: 2 })
  assert.strictEqual(res.status, 400, 'a hard-category deny must not be reconsiderable')
  assert.ok(/硬风险类别/.test(res.payload.error), 'error must name the hard-category guard')
  console.log('  ✓ 硬风险类别（system）不可追认（400）')
}

// ================= 4. neutral 的 judge-deny 可追认 =================
{
  seedEvent({
    id: 3, ts: '2026-09-16T13:20:00.000Z', sessionId: 's2', tool: 'edit',
    mode: 'danger-full-access', reason: 'r',
    justification: '编辑 Merge.yaml 添加 fake-ip-filter 白名单条目',
    verdict: 'judge-deny', kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    files: ['Merge.yaml'],
  })
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { sessionId: 's2', eventId: 3 })
  assert.strictEqual(res.status, 200, 'a neutral judge-deny must be reconsiderable')
  assert.strictEqual(res.payload.ok, true, 'reconsider succeeds')
  assert.strictEqual(res.payload.duplicate, false, 'first reconsider writes a new rule')

  const rule = res.payload.rule
  assert.strictEqual(rule.tool, 'edit', 'rule pins the tool')
  assert.strictEqual(rule.mode, 'danger-full-access', 'rule pins the mode')
  assert.strictEqual(rule.category, 'neutral', 'rule pins the category')
  assert.ok(rule.contains, 'rule carries an operation fingerprint (no blanket allow)')

  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  assert.strictEqual(cfg.allowRules.length, BASELINE_RULES + 1, 'exactly one learned rule is persisted')
  assert.strictEqual(cfg.allowRules[cfg.allowRules.length - 1].contains, rule.contains, 'persisted rule matches the response')

  // 重试指令已投递到会话
  assert.strictEqual(state.delivered.length, 1, 'a retry instruction is delivered once')
  assert.strictEqual(state.delivered[0].sid, 's2', 'delivered to the requesting session')
  assert.ok(/追认/.test(state.delivered[0].text), 'the retry message explains the re-approval')

  // 追认记录：kind=reconsidered 且带 reconsiderOf 指回原事件
  const lines = readFileSync(EVENTS_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const rec = lines.find((e) => e.kind === 'reconsidered')
  assert.ok(rec, 'a reconsidered record is appended')
  assert.strictEqual(rec.reconsiderOf, 3, 'the record points back at the original event')
  console.log('  ✓ neutral judge-deny 可追认：写指纹规则 + 投递重试 + 记录 reconsiderOf')
}

// ================= 5. 事件 API：原事件标注已追认，追认记录本身不展示 =================
{
  const res = await call(state, '/api/auto-approve/events', 'GET')
  assert.strictEqual(res.status, 200, 'events endpoint responds')
  const events = res.payload.events
  assert.ok(events.every((e) => e.kind !== 'reconsidered'), 'reconsidered bookkeeping is filtered out')
  const original = events.find((e) => e.id === 3)
  assert.ok(original, 'the original deny is still listed')
  assert.strictEqual(original.reconsidered, true, 'the original deny is marked as reconsidered')
  // 未被追认的硬拒事件不得被误标
  const hard = events.find((e) => e.id === 1)
  assert.strictEqual(hard.reconsidered, undefined, 'an untouched event carries no reconsidered flag')
  // 生效硬类别必须随事件一起下发：前端据此决定追认按钮显隐，硬编码会与服务端围栏不一致
  assert.deepStrictEqual(res.payload.hardCategories, ['deletion', 'credential', 'remote', 'system', 'bulk'],
    'the events API ships the effective hardCategories so the UI cannot disagree with the server fence')
  console.log('  ✓ 事件 API：原事件标注 reconsidered，追认记录被过滤，并下发生效 hardCategories')
}

// ================= 6. 重复追认幂等（不重复写规则） =================
{
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { sessionId: 's2', eventId: 3, retry: false })
  assert.strictEqual(res.status, 200, 're-reconsider still succeeds')
  assert.strictEqual(res.payload.duplicate, true, 'the rule is recognised as already present')
  assert.strictEqual(ruleCount(), BASELINE_RULES + 1, 'no duplicate rule is written')
  console.log('  ✓ 重复追认幂等（规则不重复写入）')
}

// ================= 7. 不存在的事件 → 404 =================
{
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { eventId: 999 })
  assert.strictEqual(res.status, 404, 'unknown event id yields 404')
  console.log('  ✓ 未知事件 → 404')
}

console.log('All reconsider tests passed successfully!')
