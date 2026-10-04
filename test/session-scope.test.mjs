/**
 * 「审批只在当前会话生效」回归测试（用户 2026-10-03 决策，对应上游 issue #4 P0-2）。
 *
 * 背景：学习计数与它沉淀出的放行规则原先都是**全局**的——任一会话靠反复触发把
 * 「工具|模式|类别」养到阈值，就能沉淀出一条影响之后所有会话的放行规则。失控/恶意
 * 会话可以这样给全局「下毒」。
 *
 * 锁定的契约：
 *   1. 带 sessionId 的沉淀规则只在归属会话生效；换会话后必须重新走判定
 *   2. 旧版无归属的自动沉淀规则（自动沉淀：/ 判定器不可用…/ 用户追认：）**停用**，
 *      在哪个会话都不匹配——它没有生效范围，继续生效等于保留跨会话放行
 *   3. 用户手写规则（描述「用户自定义」）与仓库种子/内置默认规则仍然全局生效
 *   4. denyRules 有意不过滤会话（拒绝侧跨会话只会多弹一次人工，不会放行任何东西）
 *
 * 断言针对 src/index.mjs 的真实实现，用临时 DSH_HOME 隔离。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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
const TARGET = join(WORKSPACE, 'notes.txt')
const FINGERPRINT = 'rime-独有指纹-7f3a'

/** 写入配置：allowRules 由调用方给定 */
function writeConfig(allowRules, denyRules) {
  writeFileSync(CFG_PATH, JSON.stringify({
    version: 4,
    denyKeywords: [],
    allowRules: allowRules || [],
    denyRules: denyRules || [],
    hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
    riskyThreshold: 3,
    judgeTimeoutMs: 2000,
    learning: { enabled: true },
  }, null, 2) + '\n', 'utf8')
}

writeConfig([])
process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())
const plugin = mod.default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing per-session approval scope...')

// ================= 1. ruleUsableInSession / rulesForSession 语义表 =================
{
  const learned = { tool: 'edit', description: '自动沉淀：中立 人工确认后自动放行' }
  const learnedJudgeDown = { tool: 'edit', description: '判定器不可用，人工批准后沉淀：C:/x' }
  const learnedReconsider = { tool: 'edit', description: '用户追认：同类操作自动放行' }
  const userRule = { tool: 'edit', description: '用户自定义' }
  const shipped = { mode: 'workspace-write', description: '工作区写入（可回补，对应 acceptEdits/workspace-write）' }
  const scopedA = { tool: 'edit', description: '自动沉淀：中立 人工确认后自动放行', sessionId: 'sess-a' }

  assert.strictEqual(mod.ruleUsableInSession(scopedA, 'sess-a'), true, 'a rule scoped to this session applies')
  assert.strictEqual(mod.ruleUsableInSession(scopedA, 'sess-b'), false, 'a rule scoped elsewhere must NOT apply')
  assert.strictEqual(mod.ruleUsableInSession(scopedA, ''), false, 'a scoped rule must NOT apply to an unknown session')

  for (const [name, rule] of [['自动沉淀', learned], ['判定器不可用沉淀', learnedJudgeDown], ['追认', learnedReconsider]]) {
    assert.strictEqual(mod.ruleUsableInSession(rule, 'sess-a'), false, `legacy ${name} rule is retired (no session owner)`)
    assert.strictEqual(mod.ruleUsableInSession(rule, 'sess-b'), false, `legacy ${name} rule is retired in every session`)
  }

  assert.strictEqual(mod.ruleUsableInSession(userRule, 'sess-a'), true, 'user-authored rules stay global')
  assert.strictEqual(mod.ruleUsableInSession(userRule, 'sess-b'), true, 'user-authored rules stay global (other session)')
  assert.strictEqual(mod.ruleUsableInSession(shipped, 'sess-a'), true, 'shipped/default rules stay global')
  assert.strictEqual(mod.ruleUsableInSession(null, 'sess-a'), false, 'a missing rule never matches')

  assert.deepStrictEqual(
    mod.rulesForSession([scopedA, learned, userRule, shipped], 'sess-b').map((r) => r.description),
    ['用户自定义', shipped.description],
    'rulesForSession keeps global rules and drops other sessions\u2019 plus retired learned rules',
  )
  console.log('  ✓ 作用域语义表：本会话规则可用 / 别的会话与旧沉淀规则停用 / 手写与预置全局')
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
const ALLOW_JSON = '{"decision":"allow","reason":"可回补","category":"neutral"}'
const ASK_JSON = '{"decision":"ask","reason":"不太好判断","category":"neutral"}'

function makeCtx(judgeReply) {
  const state = { handler: null, streamCalls: 0 }
  const reply = judgeReply || ALLOW_JSON
  const ctx = {
    llm: {
      stream() {
        state.streamCalls++
        return (async function* () {
          yield { type: 'text-delta', text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    permissionPresets: { current: () => 'auto-approve' },
    get: () => undefined,
    webServer: undefined,
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    on: (name, handler) => { if (name === 'approval/request') state.handler = handler; return () => {} },
  }
  return { ctx, state }
}

let seq = 0
function makeReq(sessionId) {
  seq++
  const events = [
    { type: 'tool/call', data: { callId: 'c' + seq, name: 'edit', arguments: JSON.stringify({ file_path: TARGET }) } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改一下笔记' }] } },
  ]
  return {
    callId: 'c' + seq,
    toolName: 'edit',
    reason: `escalate sandbox to danger-full-access: 修改笔记里的 ${FINGERPRINT} 标记`,
    signal: undefined,
    agent: { session: { id: sessionId, header: { cwd: WORKSPACE }, snapshotEvents: () => events } },
  }
}

async function decide(state, sessionId) {
  let nextCalls = 0
  const next = async () => { nextCalls++; return 'allowed-once' }
  const outcome = await state.handler(makeReq(sessionId), next)
  return { outcome, nextCalls }
}

/** 每个用例重新 apply：插件把 config/learning 缓存在模块作用域，热更新靠 reloadConfig */
function boot(allowRules, denyRules, judgeReply) {
  writeConfig(allowRules, denyRules)
  const { ctx, state } = makeCtx(judgeReply)
  plugin.apply(ctx)
  assert.ok(state.handler, 'the plugin must register an approval/request handler')
  return state
}

const scopedRule = (sessionId) => ({
  tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: FINGERPRINT,
  description: '自动沉淀：中立 人工确认后自动放行', sessionId,
})

// ================= 3. 沉淀规则只对归属会话生效（端到端）=================
{
  const stateA = boot([scopedRule('sess-owner')])
  const a = await decide(stateA, 'sess-owner')
  assert.strictEqual(a.outcome, 'allowed-once', 'the owning session auto-approves')
  assert.strictEqual(stateA.streamCalls, 0, 'the owning session never reaches the judge (whitelist layer)')

  const stateB = boot([scopedRule('sess-owner')])
  const b = await decide(stateB, 'sess-intruder')
  assert.ok(stateB.streamCalls > 0, 'another session must NOT be allowlisted by a rule it does not own')
  console.log('  ✓ 沉淀规则只在归属会话放行；换会话后重新走判定')
}

// ================= 4. 旧的无归属沉淀规则：哪都不生效 =================
{
  const legacyRule = {
    tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: FINGERPRINT,
    description: '自动沉淀：中立 人工确认后自动放行',
  }
  const legacyState = boot([legacyRule])
  await decide(legacyState, 'sess-any')
  assert.ok(legacyState.streamCalls > 0, 'a legacy owner-less learned rule must not auto-approve anywhere')

  // 对照：同样无 sessionId，但描述是「用户自定义」→ 全局生效
  const userRule = {
    tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: FINGERPRINT,
    description: '用户自定义',
  }
  const userState = boot([userRule])
  const out = await decide(userState, 'sess-any')
  assert.strictEqual(out.outcome, 'allowed-once', 'a user-authored global rule still auto-approves')
  assert.strictEqual(userState.streamCalls, 0, 'a user-authored global rule short-circuits before the judge')
  console.log('  ✓ 旧沉淀规则停用；手写全局规则不受影响')
}

// ================= 5. denyRules 保持全局（有意的不对称）=================
// 注意管道顺序：denyRules 在「判定 ask」之后才被查询（judge allow 就直接放行了），
// 所以这里必须让判定器回 ask 才能真正走到 denyRules 那一层。
{
  const deny = { tool: 'edit', mode: 'danger-full-access', category: 'neutral', contains: FINGERPRINT }
  const state = boot([], [deny], ASK_JSON)
  const r = await decide(state, 'sess-brand-new')
  assert.strictEqual(r.nextCalls, 1, 'a rejection from any session still forces a human (global by design)')
  assert.ok(state.streamCalls > 0, 'the judge runs before denyRules (the rule is not a whitelist shortcut)')

  // 对照：同样的 ask 判定，没有 denyRules → 走确认制学习的人工确认
  const stateNoDeny = boot([], [], ASK_JSON)
  const r2 = await decide(stateNoDeny, 'sess-brand-new')
  assert.strictEqual(r2.nextCalls, 1, 'ask still asks a human; the difference is the recorded path')
  console.log('  ✓ denyRules 跨会话仍生效（拒绝侧保持全局，只会更严）')
}

// ================= 6. 学习计数落盘带会话前缀 =================
{
  const learningPath = join(dataDir, 'learning.json')
  writeFileSync(learningPath, JSON.stringify({ enabled: true, stats: {}, history: {} }, null, 2) + '\n', 'utf8')
  // 判定器给 ask → 人工确认；人工批准 → 计数 +1
  const state = boot([], [], ASK_JSON)
  const out = await decide(state, 'sess-learn')
  assert.strictEqual(out.outcome, 'allowed-once', 'the human approved the counted operation')
  const saved = JSON.parse(readFileSync(learningPath, 'utf8'))
  const keys = Object.keys(saved.stats)
  assert.strictEqual(keys.length, 1, 'exactly one learning entry was written')
  assert.ok(keys[0].startsWith('sess-learn|'), `the learning key must carry the session prefix, got ${keys[0]}`)
  assert.strictEqual(saved.stats[keys[0]], 1, 'the confirmation is counted once')
  console.log('  ✓ 学习计数以 sessionId|tool|mode|category 落盘')
}

console.log('All per-session scope tests passed successfully!')
