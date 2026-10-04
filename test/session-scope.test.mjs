/**
 * 审批作用域回归测试（用户 2026-10-04 决策）。
 *
 * 语义：新增审批时可选作用域——**仅本次**（不写规则，只放行重试那一次）/ **本会话** /
 * **全局**；设置页的「新沉淀作用域」决定人工确认后自动沉淀的规则写在哪一层。
 * 旧版**无归属的沉淀规则回到全局生效**（0.9.3 曾把它们判为停用，本版迁回）。
 *
 * 锁定的契约：
 *   1. ruleScope/ruleUsableInSession：global 处处生效；session 只在归属会话生效；
 *      声明 session 却没有 sessionId → 'none'（fail-safe，绝不因此升级成全局）
 *   2. 端到端：会话规则只放行归属会话；旧的无归属沉淀规则对**任何**会话都放行
 *   3. 「仅本次」：不写规则，只放行一次，消费后立即失效
 *   4. 设置页 sedimentScope=global → 自动沉淀写全局规则
 *   5. promote：会话规则一键提升为全局
 *   6. denyRules 仍跨会话生效（拒绝侧有意保持全局）
 *
 * 断言针对 src/index.mjs 的真实实现，用临时 DSH_HOME 隔离。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-session-scope-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
const WORKSPACE = join(tempHome, 'ws')
mkdirSync(dataDir, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })

const CFG_PATH = join(dataDir, 'allowlist.json')
const LEARNING_PATH = join(dataDir, 'learning.json')
const EVENTS_PATH = join(dataDir, 'events.jsonl')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())
const plugin = mod.default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing approval scope (once / session / global)...')

const readCfg = () => JSON.parse(readFileSync(CFG_PATH, 'utf8'))

function writeConfig(patch) {
  writeFileSync(CFG_PATH, JSON.stringify(Object.assign({
    version: 4,
    denyKeywords: [],
    allowRules: [],
    denyRules: [],
    hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
    riskyThreshold: 3,
    judgeTimeoutMs: 2000,
    // 本文件只测「规则作用域」（本会话 / 全局 / 一次性 / 提升）：
    // 关掉 0.9.7 的定域放行层，否则工作区内的调用会被它直接放行，
    // 「另一个会话不被本会话规则放行」这条断言就观察不到判定器了。
    // 定域放行 / 危险动作围栏由 test/fence-scope.test.mjs 覆盖。
    scopeAutoAllow: false,
    learning: { enabled: true },
  }, patch || {}), null, 2) + '\n', 'utf8')
}
writeConfig()

// ================= 1. 作用域判定语义表 =================
{
  const userRule = { tool: 'edit', description: '用户自定义' }
  const shipped = { mode: 'workspace-write', description: '工作区写入（可回补）' }
  const legacyLearned = { tool: 'edit', description: '自动沉淀：中立 人工确认后自动放行' }
  const legacyReconsider = { tool: 'edit', description: '用户追认：同类操作自动放行' }
  const scoped = { tool: 'edit', description: '自动沉淀：中立', scope: 'session', sessionId: 'sess-a' }
  const globalExplicit = { tool: 'edit', description: '自动沉淀：中立', scope: 'global' }
  const brokenScope = { tool: 'edit', description: '自动沉淀：中立', scope: 'session' }

  assert.strictEqual(mod.ruleScope(userRule), 'global', 'a user-authored rule is global')
  assert.strictEqual(mod.ruleScope(shipped), 'global', 'a shipped rule is global')
  assert.strictEqual(mod.ruleScope(legacyLearned), 'global', 'a legacy owner-less learned rule is global again (2026-10-04)')
  assert.strictEqual(mod.ruleScope(legacyReconsider), 'global', 'a legacy owner-less re-approval rule is global again')
  assert.strictEqual(mod.ruleScope({ tool: 'edit', sessionId: 's1' }), 'session', 'a 0.9.3-era rule with sessionId stays session-scoped')
  assert.strictEqual(mod.ruleScope(scoped), 'session', 'an explicit session scope is session-scoped')
  assert.strictEqual(mod.ruleScope(globalExplicit), 'global', 'an explicit global scope wins')
  assert.strictEqual(mod.ruleScope(brokenScope), 'none', 'a session scope without an owner can never match (fail-safe)')

  assert.strictEqual(mod.ruleUsableInSession(legacyLearned, 'any-session'), true, 'legacy learned rules apply everywhere')
  assert.strictEqual(mod.ruleUsableInSession(scoped, 'sess-a'), true, 'the owning session is allowed')
  assert.strictEqual(mod.ruleUsableInSession(scoped, 'sess-b'), false, 'another session is not')
  assert.strictEqual(mod.ruleUsableInSession(globalExplicit, 'sess-b'), true, 'an explicit global rule applies anywhere')
  assert.strictEqual(mod.ruleUsableInSession(brokenScope, 'any-session'), false, 'a broken session scope never applies')

  assert.deepStrictEqual(
    mod.rulesForSession([scoped, legacyLearned, userRule, shipped, brokenScope], 'sess-b').map((r) => r.description),
    [legacyLearned.description, '用户自定义', shipped.description],
    'rulesForSession keeps global rules and drops other sessions\u2019 plus broken scopes',
  )
  console.log('  ✓ 作用域语义表：本会话 / 全局 / 旧沉淀回全局 / 无归属的会话规则不生效')
}

// ================= 2. 学习 key 形态与展示 =================
{
  assert.strictEqual(mod.describeLearnKey('sess-abcdef123456|edit|workspace-write|neutral'),
    'edit|workspace-write|neutral · 会话 sess-abcdef1', 'the session prefix is stripped and summarised')
  assert.strictEqual(mod.describeLearnKey('|edit|workspace-write|neutral'),
    'edit|workspace-write|neutral · 无会话归属', 'a key without a session is called out')
  console.log('  ✓ 学习 key 带会话前缀，展示时去掉前缀并标注会话')
}

// ================= 端到端夹具 =================
function makeCtx(judgeReplies) {
  const state = { handler: null, routes: new Map(), streamCalls: 0, systems: [] }
  let call = 0
  const ctx = {
    llm: {
      stream(options) {
        state.streamCalls++
        state.systems.push(String(options.system || ''))
        const reply = judgeReplies ? judgeReplies[call++] : '{"decision":"allow","reason":"可回补","category":"neutral"}'
        return (async function* () {
          yield { type: 'text-delta', text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    permissionPresets: { current: () => 'auto-approve' },
    get: () => undefined,
    webServer: { register: (spec) => { state.routes.set(spec.path, spec); return () => {} } },
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    on: (name, handler) => { if (name === 'approval/request') state.handler = handler; return () => {} },
  }
  return { ctx, state }
}

let seq = 0
function makeReq(sessionId, justification, filePath) {
  seq++
  const events = [
    { type: 'tool/call', data: { callId: 'c' + seq, name: 'edit', arguments: JSON.stringify({ file_path: filePath }) } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改一下文件' }] } },
  ]
  return {
    callId: 'c' + seq,
    toolName: 'edit',
    reason: `escalate sandbox to danger-full-access: ${justification}`,
    signal: undefined,
    agent: { session: { id: sessionId, header: { cwd: WORKSPACE }, snapshotEvents: () => events } },
  }
}

async function decide(state, sessionId, justification, filePath) {
  let nextCalls = 0
  const next = async () => { nextCalls++; return 'allowed-once' }
  const outcome = await state.handler(makeReq(sessionId, justification, filePath), next)
  return { outcome, nextCalls }
}

function boot(patch, judgeReplies) {
  writeConfig(patch)
  writeFileSync(LEARNING_PATH, JSON.stringify({ enabled: true, stats: {}, history: {} }, null, 2) + '\n', 'utf8')
  writeFileSync(EVENTS_PATH, '', 'utf8')
  const { ctx, state } = makeCtx(judgeReplies)
  plugin.apply(ctx)
  assert.ok(state.handler, 'the plugin must register an approval/request handler')
  return state
}

async function post(state, path, body) {
  const route = state.routes.get(path)
  assert.ok(route, `route ${path} must be registered`)
  const listeners = { data: [], end: [], error: [] }
  const req = { method: 'POST', url: path, headers: { host: '127.0.0.1:43120' }, on: (ev, fn) => { if (listeners[ev]) listeners[ev].push(fn) } }
  setImmediate(() => { const s = JSON.stringify(body); for (const fn of listeners.data) fn(s); for (const fn of listeners.end) fn() })
  const res = { status: 0, payload: null }
  res.writeHead = (code) => { res.status = code }
  res.end = (text) => { try { res.payload = JSON.parse(text) } catch { res.payload = text } }
  await route.handler(req, res)
  return res
}

/** 造一条可追认的静默拒绝事件（判定器判 deny / neutral） */
function seedDenyEvent(sessionId, justification, filePath) {
  const rows = readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean)
  const ev = {
    id: rows.length + 1, ts: new Date().toISOString(), sessionId,
    tool: 'edit', mode: 'danger-full-access', reason: 'r', justification,
    verdict: 'judge-deny', kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    files: [filePath], command: '',
  }
  appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

const JUST_A = '往 once-target.yaml 里补一句说明'
const FILE_A = join(WORKSPACE, 'once-target.yaml')
const JUST_B = '往 promote-target.yaml 里补一句说明'
const FILE_B = join(WORKSPACE, 'promote-target.yaml')

// ================= 3. 会话规则只放行归属会话 =================
{
  const rule = { tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: 'once-target.yaml', description: '自动沉淀：中立', scope: 'session', sessionId: 'sess-owner' }
  const s1 = boot({ allowRules: [rule] })
  const owner = await decide(s1, 'sess-owner', JUST_A, FILE_A)
  assert.strictEqual(owner.outcome, 'allowed-once', 'the owning session is allowlisted')
  assert.strictEqual(s1.streamCalls, 0, 'the owning session never reaches the judge')

  const s2 = boot({ allowRules: [rule] })
  await decide(s2, 'sess-other', JUST_A, FILE_A)
  assert.ok(s2.streamCalls > 0, 'another session must not be allowlisted by a session-scoped rule')
  console.log('  ✓ 会话规则只在归属会话放行；换会话重新走判定')
}

// ================= 4. 旧的无归属沉淀规则回到全局 =================
{
  const legacy = { tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: 'once-target.yaml', description: '自动沉淀：中立 人工确认后自动放行' }
  for (const sid of ['sess-a', 'sess-b']) {
    const state = boot({ allowRules: [legacy] })
    const r = await decide(state, sid, JUST_A, FILE_A)
    assert.strictEqual(r.outcome, 'allowed-once', `a legacy owner-less learned rule applies in ${sid}`)
    assert.strictEqual(state.streamCalls, 0, `no judge call in ${sid} (the legacy rule is global again)`)
  }
  // 对照：声明 session 作用域却没有归属 → 任何会话都不生效（fail-safe，不会变成全局）
  const broken = { tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: 'once-target.yaml', description: '自动沉淀：中立', scope: 'session' }
  const s3 = boot({ allowRules: [broken] })
  await decide(s3, 'sess-a', JUST_A, FILE_A)
  assert.ok(s3.streamCalls > 0, 'a session scope without an owner must not be treated as global')
  console.log('  ✓ 旧沉淀规则全局生效；无归属的会话规则不生效')
}

// ================= 5. denyRules 仍跨会话 =================
{
  const deny = { tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: 'once-target.yaml' }
  const state = boot({ allowRules: [], denyRules: [deny] }, ['{"decision":"ask","reason":"不太好判断","category":"neutral"}'])
  const r = await decide(state, 'sess-brand-new', JUST_A, FILE_A)
  assert.strictEqual(r.nextCalls, 1, 'a rejection from any session still forces a human (global by design)')
  console.log('  ✓ denyRules 跨会话仍生效（拒绝侧保持全局）')
}

// ================= 6. 「仅本次」：不写规则，只放行一次 =================
{
  const state = boot({ sedimentScope: 'session' })
  const ev = seedDenyEvent('sess-once', JUST_A, FILE_A)
  const before = readCfg().allowRules.length
  const res = await post(state, '/api/auto-approve/reconsider', { sessionId: 'sess-once', eventId: ev.id, scope: 'once' })
  assert.strictEqual(res.status, 200, 'once-only reconsideration succeeds')
  assert.strictEqual(res.payload.scope, 'once', 'the response reports the chosen scope')
  assert.strictEqual(res.payload.rule, null, 'no rule is returned for a once-only approval')
  assert.strictEqual(readCfg().allowRules.length, before, 'no rule is written for once-only')

  // 重试那一次：白名单层直接放行，不调用判定器
  const callsBefore = state.streamCalls
  const retry = await decide(state, 'sess-once', JUST_A, FILE_A)
  assert.strictEqual(retry.outcome, 'allowed-once', 'the retry is allowed once')
  assert.strictEqual(state.streamCalls, callsBefore, 'the once grant short-circuits the judge')

  // 额度已消费：下一次同样的调用必须重新判定
  const after = await decide(state, 'sess-once', JUST_A, FILE_A)
  assert.ok(state.streamCalls > callsBefore, `the once grant is consumed (judge calls now ${state.streamCalls})`)
  assert.strictEqual(after.outcome, 'allowed-once', 'the judge decides the second call on its own merits')
  console.log('  ✓ 「仅本次」：不写规则，只放行重试那一次')
}

// ================= 7. 追认的会话 / 全局作用域 =================
{
  // 7a. session（默认）：归属会话放行，别的会话不放行
  const s1 = boot({})
  const evA = seedDenyEvent('sess-keep', JUST_B, FILE_B)
  const rA = await post(s1, '/api/auto-approve/reconsider', { sessionId: 'sess-keep', eventId: evA.id })
  assert.strictEqual(rA.payload.scope, 'session', 'the default scope is session')
  assert.strictEqual(rA.payload.rule.scope, 'session', 'the rule is marked session-scoped')
  assert.strictEqual(rA.payload.rule.sessionId, 'sess-keep', 'the rule carries its owner')
  const inSession = await decide(s1, 'sess-keep', JUST_B, FILE_B)
  assert.strictEqual(inSession.outcome, 'allowed-once', 'the owner session is allowlisted by the reconsidered rule')

  const cfgWithRule = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
  assert.ok(cfgWithRule.allowRules.some((r) => r.scope === 'session' && r.sessionId === 'sess-keep'), 'the session rule is persisted')

  // 7b. global：显式选全局时不需要会话归属，且对别的会话生效
  const s2 = boot({})
  const evB = seedDenyEvent('sess-giver', JUST_A, FILE_A)
  const rB = await post(s2, '/api/auto-approve/reconsider', { sessionId: 'sess-giver', eventId: evB.id, scope: 'global' })
  assert.strictEqual(rB.payload.scope, 'global', 'the global scope is honoured')
  assert.strictEqual(rB.payload.rule.scope, 'global', 'the rule is marked global')
  assert.strictEqual(rB.payload.rule.sessionId, undefined, 'a global rule carries no session owner')

  const other = await decide(s2, 'sess-stranger', JUST_A, FILE_A)
  assert.strictEqual(other.outcome, 'allowed-once', 'a global rule allowlists another session')
  assert.strictEqual(s2.streamCalls, 0, 'the global rule short-circuits the judge')

  // 7c. 「已生效的全局规则」再提升：幂等返回 already
  const prom = await post(s2, '/api/auto-approve/rules', { op: 'promote', kind: 'allowRules', value: { tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: readCfg().allowRules.find((r) => r.scope === 'global').contains } })
  assert.strictEqual(prom.payload.ok, true, 'promoting an already-global rule is a no-op success')
  assert.strictEqual(prom.payload.already, true, '…reported as already global')
  console.log('  ✓ 追认：本会话（默认）/ 全局（显式）作用域各自生效')
}

// ================= 8. 一键提升为全局 =================
{
  const state = boot({})
  const ev = seedDenyEvent('sess-lift', JUST_B, FILE_B)
  const r = await post(state, '/api/auto-approve/reconsider', { sessionId: 'sess-lift', eventId: ev.id, scope: 'session' })
  assert.strictEqual(r.payload.rule.scope, 'session', 'starts session-scoped')
  const value = { tool: r.payload.rule.tool, mode: r.payload.rule.mode, category: r.payload.rule.category, contains: r.payload.rule.contains, sessionId: r.payload.rule.sessionId }
  const promote = await post(state, '/api/auto-approve/rules', { op: 'promote', kind: 'allowRules', value })
  assert.strictEqual(promote.payload.promoted, true, 'the session rule is promoted')
  const lifted = readCfg().allowRules.find((x) => x.contains === r.payload.rule.contains)
  assert.strictEqual(lifted.scope, 'global', 'the rule is now global')
  assert.strictEqual(lifted.sessionId, undefined, 'the session owner is dropped when promoting')

  const other = await decide(state, 'sess-other', JUST_B, FILE_B)
  assert.strictEqual(other.outcome, 'allowed-once', 'another session is now allowlisted')
  assert.strictEqual(state.streamCalls, 0, 'the promoted rule short-circuits the judge')
  console.log('  ✓ 会话规则一键提升为全局，其他会话随即放行')
}

// ================= 9. 设置页的沉淀作用域决定自动沉淀写在哪一层 =================
{
  // sedimentScope=global：判定器回 ask → 人工确认 → flash 判同类（SAME）→ 沉淀**全局**规则
  const state = boot({ sedimentScope: 'global' }, ['{"decision":"ask","reason":"不太好判断","category":"neutral"}', 'SAME'])
  const key = 'sess-learn|edit|danger-full-access|neutral'
  writeFileSync(LEARNING_PATH, JSON.stringify({
    enabled: true,
    stats: { [key]: 3 },
    history: { [key]: [{ fp: null, ctx: '往 y 文件补一句说明', ts: new Date().toISOString() }] },
  }, null, 2) + '\n', 'utf8')
  const r = await decide(state, 'sess-learn', '往 yaml 补一句说明 C:/ws/y.yaml', FILE_A)
  assert.strictEqual(r.outcome, 'allowed-once', 'the learned-threshold operation auto-approves')
  const written = readCfg().allowRules.filter((x) => String(x.description || '').indexOf('自动沉淀') === 0)
  assert.strictEqual(written.length, 1, 'exactly one sedimented rule is written')
  assert.strictEqual(written[0].scope, 'global', 'sedimentScope=global sediments a global rule')
  assert.strictEqual(written[0].sessionId, undefined, 'a global sediment carries no owner')

  // 默认（未配置）= session：沉淀规则带归属
  const state2 = boot({}, ['{"decision":"ask","reason":"不太好判断","category":"neutral"}', 'SAME'])
  writeFileSync(LEARNING_PATH, JSON.stringify({
    enabled: true,
    stats: { [key]: 3 },
    history: { [key]: [{ fp: null, ctx: '往 y 文件补一句说明', ts: new Date().toISOString() }] },
  }, null, 2) + '\n', 'utf8')
  await decide(state2, 'sess-learn', '往 yaml 补一句说明 C:/ws/y.yaml', FILE_A)
  const written2 = readCfg().allowRules.filter((x) => String(x.description || '').indexOf('自动沉淀') === 0)
  assert.strictEqual(written2.length, 1, 'exactly one sedimented rule is written by default too')
  assert.strictEqual(written2[0].scope, 'session', 'the default sedimentScope is session')
  assert.strictEqual(written2[0].sessionId, 'sess-learn', 'the session sediment carries its owner')
  console.log('  ✓ 沉淀作用域：设置为 global 写全局规则，默认写本会话规则')
}

console.log('All approval scope tests passed successfully!')
