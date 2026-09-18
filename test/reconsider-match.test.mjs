/**
 * 「追认后同类操作仍被拦」与「插件注入消息缺 source」两处缺陷的回归测试（2026-09-18）。
 *
 * 缺陷来源（会话 session-66609e2c 事故复盘）：
 *   1. 追认端点写入的放行规则只带一个「最长指纹」（如 C:\Users\<u>\AppData\Roaming\Rime），
 *      而管道拿它与**下一次调用**的 justification 比对；justification 很少逐字复现
 *      （措辞不同、不含绝对路径），规则因此静默失效 → 重试仍进判定器 → 判定器不可用时再次静默拒绝。
 *      修复：a) 规则另存 keywords 多候选指纹；b) 匹配文本归一化（反斜杠/大小写/空白）
 *      并加词边界；c) 匹配上下文补上本次调用的真实目标文件路径（ruleMatchContext）。
 *   2. sendToSession 经 agent.followup() 注入的重试指令缺 source 字段，DSH 核心监听器
 *      读 message.source.kind 抛 TypeError，会话后续回合全部失败。
 *      修复：注入消息带 source: { kind: 'plugin', plugin: 'dsh-approval-gate' }。
 *
 * 全部断言针对 src/index.mjs 的真实实现；用临时 DSH_HOME 隔离，不触碰真实 ~/.dsh/auto-approve。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-match-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
mkdirSync(dataDir, { recursive: true })

const EVENTS_PATH = join(dataDir, 'events.jsonl')
const CONFIG_PATH = join(dataDir, 'allowlist.json')

writeFileSync(CONFIG_PATH, JSON.stringify({
  version: 4,
  denyKeywords: [],
  allowRules: [],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 3,
  judgeTimeoutMs: 300,
  learning: { enabled: true },
}, null, 2) + '\n', 'utf8')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())
const plugin = mod.default
const { matchRule, normalizeMatchText, extractFingerprintCandidates } = mod

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing reconsider rule matching + injected message source...')

// ================= 1. 匹配文本归一化 =================
{
  assert.strictEqual(
    normalizeMatchText('C:\\Users\\mashi\\AppData\\Roaming\\Rime'),
    'c:/users/mashi/appdata/roaming/rime',
    '反斜杠与小写归一化')
  console.log('  ✓ 归一化：反斜杠 → 斜杠、小写、压缩空白')
}

// ================= 2. 候选指纹提取（事故原文） =================
const EVENT_1_TEXT = '用户明确要求修复 Rime 自定义短语并做防覆盖改造，新建的个人词库必须落在 Rime 用户目录 C:\\Users\\mashi\\AppData\\Roaming\\Rime，该路径在会话工作区之外。'
const EVENT_3_TEXT = '需在 Rime 用户目录（工作区之外）创建 wanxiang_phrase.custom.yaml 并修改 wanxiang.custom.yaml 一行。'
{
  const c1 = extractFingerprintCandidates(EVENT_1_TEXT)
  assert.ok(c1.some((c) => normalizeMatchText(c).includes('appdata/roaming/rime')),
    '绝对路径必须成为候选指纹')
  const c3 = extractFingerprintCandidates(EVENT_3_TEXT)
  assert.ok(c3.some((c) => c.toLowerCase() === 'wanxiang_phrase.custom.yaml'),
    '带扩展名的文件名必须成为候选指纹')
  assert.strictEqual(new Set(c1.map(normalizeMatchText)).size, c1.length, '候选去重')
  console.log('  ✓ 候选指纹：绝对路径 + 多文件名 + 去重')
}

// ================= 3. 事故复现：追认规则在「下一次同类调用」上是否生效 =================
{
  const ruleLegacy = { tool: 'write', mode: 'danger-full-access', category: 'neutral', contains: 'C:\\Users\\mashi\\AppData\\Roaming\\Rime' }
  const keywords = extractFingerprintCandidates(EVENT_1_TEXT + ' ' + EVENT_3_TEXT)
  const ruleWithKeywords = { ...ruleLegacy, keywords: keywords.filter((k) => k !== ruleLegacy.contains) }

  // 旧行为：管道只拿 justification 匹配（不含绝对路径）→ 规则失效，事故由此发生
  const justificationOnly = '用户已明确授权：新建生产者侧补丁文件，把 custom_phrase 词典重定向到 my_phrase，需写入工作区之外的 Rime 用户目录。'
  assert.strictEqual(matchRule([ruleLegacy], 'write', 'danger-full-access', 'neutral', justificationOnly), null,
    '仅 justification 时规则不命中（复现事故现场）')

  // 修复后：匹配上下文含本次调用的真实目标文件（ruleMatchContext）
  const withFiles = justificationOnly + ' ' + 'C:\\Users\\mashi\\AppData\\Roaming\\Rime\\wanxiang_phrase.custom.yaml'
  assert.ok(matchRule([ruleLegacy], 'write', 'danger-full-access', 'neutral', withFiles),
    '带真实文件路径的上下文命中旧规则（本次修复的核心）')
  assert.ok(matchRule([ruleWithKeywords], 'write', 'danger-full-access', 'neutral', withFiles),
    '带真实文件路径的上下文命中 keywords 规则')
  assert.ok(matchRule([ruleLegacy], 'write', 'danger-full-access', 'neutral', withFiles.toLowerCase().replace(/\\/g, '/')),
    '斜杠方向与大小写不同也能命中')
  console.log('  ✓ 事故复现与修复：仅 justification 不命中；含目标路径即命中')
}

// ================= 4. 负向控制：不得因归一化而过度放行 =================
{
  const rule = { tool: 'write', mode: 'danger-full-access', category: 'neutral', contains: 'C:\\Users\\mashi\\AppData\\Roaming\\Rime' }
  assert.strictEqual(matchRule([rule], 'write', 'danger-full-access', 'neutral', 'C:\\Users\\mashi\\AppData\\Roaming\\RimeX\\a.yaml'), null,
    '前缀同形目录（RimeX）不得被 Rime 规则放行')
  assert.strictEqual(matchRule([rule], 'write', 'danger-full-access', 'neutral', 'C:\\Users\\mashi\\AppData\\Roaming\\Rime-old\\a.yaml'), null,
    '连字符后缀目录不得被放行')
  assert.strictEqual(matchRule([rule], 'pwsh', 'danger-full-access', 'neutral', 'C:\\Users\\mashi\\AppData\\Roaming\\Rime\\a.yaml'), null,
    '工具不同不命中')
  assert.strictEqual(matchRule([rule], 'write', 'workspace-write', 'neutral', 'C:\\Users\\mashi\\AppData\\Roaming\\Rime\\a.yaml'), null,
    '沙箱模式不同不命中')
  assert.strictEqual(matchRule([rule], 'write', 'danger-full-access', 'deletion', 'C:\\Users\\mashi\\AppData\\Roaming\\Rime\\a.yaml'), null,
    '类别不同不命中')
  assert.ok(matchRule([{ tool: 'write', mode: 'danger-full-access', category: 'neutral' }], 'write', 'danger-full-access', 'neutral', '任意说明'),
    '无指纹的规则（工具+模式+类别）仍按宽规则匹配')
  assert.strictEqual(matchRule([rule], 'write', 'danger-full-access', 'neutral', '完全无关的说明 C:\\other\\path'), null,
    '无关说明不命中')
  console.log('  ✓ 负向控制：目录前缀、工具、模式、类别、无关说明均不放行')
}

// ================= 模拟宿主：只暴露 HTTP 路由 =================
function makeCtx() {
  const state = { routes: new Map(), delivered: [] }
  const ctx = {
    llm: { stream: () => { throw new Error('judge must not be called in this test') } },
    permissionPresets: { current: () => 'auto-approve' },
    get: (key) => (key === 'agents'
      ? { get: (sid) => ({ followup: (msg) => { state.delivered.push({ sid, message: msg }) } }) }
      : undefined),
    webServer: { register: (spec) => { state.routes.set(spec.path, spec); return () => {} } },
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    on: () => () => {},
  }
  return { ctx, state }
}

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

function seedEvent(ev) {
  appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n', 'utf8')
}

const { ctx, state } = makeCtx()
plugin.apply(ctx)

const readRules = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).allowRules
const BASELINE_RULES = readRules().length

// ================= 5. 追认写入的规则带 keywords，且注入消息带 source =================
{
  seedEvent({
    id: 11, ts: '2026-09-18T05:55:44.000Z', sessionId: 's-rime', tool: 'write',
    mode: 'danger-full-access', reason: 'r', justification: EVENT_1_TEXT,
    verdict: 'judge-deny', kind: 'judge-deny', path: 'judge-unavailable', category: 'neutral',
    files: ['C:\\Users\\mashi\\AppData\\Roaming\\Rime\\my_phrase.dict.yaml'],
  })
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { sessionId: 's-rime', eventId: 11 })
  assert.strictEqual(res.status, 200, 'neutral judge-deny 可追认')
  const rule = res.payload.rule
  assert.ok(rule.contains, '规则仍带最长指纹')
  assert.ok(Array.isArray(rule.keywords) && rule.keywords.length > 0, '规则额外携带多候选 keywords')
  assert.ok(rule.keywords.some((k) => normalizeMatchText(k).includes('appdata/roaming/rime')),
    'keywords 覆盖目录路径')
  assert.ok(rule.keywords.some((k) => k.toLowerCase() === 'my_phrase.dict.yaml'),
    'keywords 覆盖事件 files 里的文件名')

  // 新规则能放行下一次同类写入（含真实文件路径的上下文），且不放行无关目录
  const nextCall = '用户重新执行同一次写入 C:\\Users\\mashi\\AppData\\Roaming\\Rime\\my_phrase.dict.yaml'
  assert.ok(matchRule(readRules(), 'write', 'danger-full-access', 'neutral', nextCall),
    '新规则放行同类写入')
  assert.strictEqual(matchRule(readRules(), 'write', 'danger-full-access', 'neutral', 'C:\\Users\\mashi\\AppData\\Roaming\\RimeX\\x.yaml'), null,
    '新规则不放行同形前缀目录')

  // 注入的「请重试」消息必须带 source，否则 DSH 核心监听器抛
  // TypeError: Cannot read properties of undefined (reading 'kind')
  assert.strictEqual(state.delivered.length, 1, '重试指令投递一次')
  const injected = state.delivered[0].message
  assert.ok(injected.source, '注入消息必须带 source（否则会话回合崩溃）')
  assert.strictEqual(injected.source.kind, 'plugin', 'source.kind=plugin')
  assert.strictEqual(injected.source.plugin, 'dsh-approval-gate', 'source.plugin 标明来源插件')
  console.log('  ✓ 追认：规则带 keywords 且可放行同类；注入消息带 source.kind=plugin')
}

// ================= 6. 重复追认：补齐并集，不重复写规则 =================
{
  seedEvent({
    id: 12, ts: '2026-09-18T05:56:24.000Z', sessionId: 's-rime', tool: 'write',
    mode: 'danger-full-access', reason: 'r', justification: EVENT_1_TEXT,
    verdict: 'judge-deny', kind: 'judge-deny', path: 'judge-unavailable', category: 'neutral',
    files: ['C:\\Users\\mashi\\AppData\\Roaming\\Rime\\wanxiang_phrase.custom.yaml'],
  })
  const before = readRules()
  const res = await call(state, '/api/auto-approve/reconsider', 'POST', { sessionId: 's-rime', eventId: 12, retry: false })
  assert.strictEqual(res.status, 200, '重复追认仍成功')
  assert.strictEqual(res.payload.duplicate, true, '识别为同一规则')
  const after = readRules()
  assert.strictEqual(after.length, before.length, '不重复写入规则')
  assert.strictEqual(after.length, BASELINE_RULES + 1, '总共只多出这一条追认规则')
  const merged = after[after.length - 1]
  assert.ok(merged.keywords.some((k) => k.toLowerCase() === 'wanxiang_phrase.custom.yaml'),
    '重复追认把新出现的文件名并入 keywords（旧规则缺此形态）')
  console.log('  ✓ 重复追认：keywords 并集补齐，规则条数不变')
}

console.log('All reconsider-match tests passed successfully!')