/**
 * 第 ④ 步回归测试（用户 2026-10-05 决策）：
 *   ① git 按命令锚定 —— 规则只按**真实事实**（命令 + 真实目标）匹配，模型措辞不再授予权限
 *   ② 工作区外一律人工 —— 目标含工作区之外的路径即转人工（白名单仍先生效）
 *   ③ 敏感路径形态永远人工 —— `.ssh` / `.aws` / `*.pem` / `.env` / Cookies … 不论在工作区内还是外
 *
 * 锁定的契约：
 *   1. `contains` 规则**不**匹配 justification 里的词：说明写「git push」而命令是 `node verify.mjs`
 *      → 不走规则层（实测 30 天 840 条规则放行里 152 条命令里根本没有规则词）；
 *   2. 锚定为空（没命令也没目标）→ 含 `contains` 的规则不匹配（fail-closed）；
 *   3. 命令里真的有那个词 → 规则照常命中；
 *   4. 敏感路径永远人工：即便规则命中、即便目标在 `$DSH_HOME` 下；
 *   5. 源码目录里的 `credential/` 不算敏感（不做全路径子串匹配）；
 *   6. `$DSH_HOME` 下的命令类工具维护（`pnpm --dir … install`、改 pin）仍自动放行 ——
 *      这是用户 2026-10-04 的决策，不能被「工作区外一律人工」推翻；
 *   7. 工作区外 / 跨内外 → 人工；关掉开关则退回判定器；
 *   8. **白名单排在「工作区外一律人工」之前**：用户手写的区外规则（如 `%APPDATA%\Rime`）仍生效；
 *   9. 工作区内目标仍走定域放行（回归护栏）；
 *  10. 追认写下的规则指纹来自**命令**，因此能在锚定后的白名单层命中。
 *
 * 断言针对 src/index.mjs 的真实导出与真实管道，用临时 DSH_HOME 隔离。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-step4-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
const WORKSPACE = join(tempHome, 'ws')
const OUTSIDE = join(tempHome, 'outside')
mkdirSync(dataDir, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })

const CFG_PATH = join(dataDir, 'allowlist.json')
const LEARNING_PATH = join(dataDir, 'learning.json')
const EVENTS_PATH = join(dataDir, 'events.jsonl')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const toHref = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href
const mod = await import(toHref('src/index.mjs') + '?t=' + Date.now())
const plugin = mod.default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing step ④ (command anchoring / outside→human / sensitive paths)...')

function writeConfig(patch) {
  writeFileSync(CFG_PATH, JSON.stringify(Object.assign({
    version: 5,
    denyKeywords: [],
    allowRules: [],
    denyRules: [],
    hardCategories: [],
    riskyThreshold: 3,
    judgeTimeoutMs: 2000,
    judgeFailureLimit: 1,
    judgeMaxTokens: 1024,
    scopeAutoAllow: true,
    outsideNeedsHuman: true,
    learning: { enabled: true },
  }, patch || {}), null, 2) + '\n', 'utf8')
}
const readCfg = () => JSON.parse(readFileSync(CFG_PATH, 'utf8'))

// ================= 1. 锚定文本 + 敏感路径：单元契约 =================
{
  const a = mod.ruleAnchorText
  assert.strictEqual(a('git push origin main', null, null), 'git push origin main', 'the command is the anchor')
  assert.strictEqual(a('', ['src/x.mjs'], null), 'src/x.mjs', 'a write target anchors when there is no command')
  assert.strictEqual(a('', null, ['C:\\a\\b']), 'C:\\a\\b', 'absolute targets anchor too')
  assert.strictEqual(a('', null, null), '', 'no facts at all → an empty anchor (fail-closed)')
  assert.ok(a('cmd', ['f1'], ['t1']).includes('cmd') && a('cmd', ['f1'], ['t1']).includes('f1'),
    'the anchor combines command, write targets and absolute targets')

  const s = mod.sensitiveTargetHit
  assert.strictEqual(s(['c:\\users\\me\\.ssh\\id_rsa']), 'c:\\users\\me\\.ssh\\id_rsa', 'a private key is sensitive')
  assert.strictEqual(s(['c:\\users\\me\\.aws\\credentials']), 'c:\\users\\me\\.aws\\credentials', 'cloud credentials are sensitive')
  assert.strictEqual(s(['d:\\ws\\proj\\.env']), 'd:\\ws\\proj\\.env', 'a .env inside the workspace is sensitive too')
  assert.strictEqual(s(['d:\\ws\\cert\\server.pem']), 'd:\\ws\\cert\\server.pem', 'a .pem is sensitive')
  assert.strictEqual(s(['c:\\users\\me\\.git-credentials']), 'c:\\users\\me\\.git-credentials', 'git credentials are sensitive')
  assert.strictEqual(s(['c:\\users\\me\\.dsh\\auto-approve\\allowlist.json']),
    'c:\\users\\me\\.dsh\\auto-approve\\allowlist.json', "the gate's own data directory is sensitive")
  assert.strictEqual(s(['d:\\ws\\src\\credential\\transport.ts']), undefined,
    'a source directory named "credential" must NOT be treated as a secret')
  assert.strictEqual(s(['d:\\ws\\scripts\\secure-secret-hydration.test.ts']), undefined,
    'a test file whose name contains "secret" must NOT be treated as a secret')
  assert.strictEqual(s(['d:\\ws\\src\\a.mjs']), undefined, 'an ordinary source file is not sensitive')
  console.log('  ✓ 锚定文本：命令 + 真实目标；敏感路径：目录段 / basename 口径（源码目录不误报）')
}

// ================= 端到端夹具 =================
function makeCtx() {
  const state = { handler: null, routes: new Map(), streamCalls: 0 }
  const ctx = {
    llm: {
      stream() {
        state.streamCalls++
        return (async function* () {
          yield { type: 'text-delta', text: '{"decision":"allow","reason":"可回补","category":"neutral"}' }
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
function makeReq(sessionId, justification, toolName, args) {
  seq++
  const callId = 'c' + seq
  const events = [
    { type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(args) } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '执行一下' }] } },
  ]
  return {
    callId,
    toolName,
    reason: `escalate sandbox to danger-full-access: ${justification}`,
    agent: { session: { id: sessionId, header: { cwd: WORKSPACE }, snapshotEvents: () => events } },
  }
}

function boot(patch) {
  writeConfig(patch)
  writeFileSync(LEARNING_PATH, JSON.stringify({ enabled: true, stats: {}, history: {} }, null, 2) + '\n', 'utf8')
  writeFileSync(EVENTS_PATH, '', 'utf8')
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)
  assert.ok(state.handler, 'the plugin must register an approval/request handler')
  return state
}

async function decide(state, sessionId, justification, toolName, args) {
  // 只取**本次调用**写下的事件：事件文件里可能已经有别的记录（如测试自己造的追认样本），
  // 直接取 events[0] 会读到别人的裁决。
  const before = readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean).length
  const next = async () => 'allowed-once'
  const outcome = await state.handler(makeReq(sessionId, justification, toolName, args), next)
  const events = readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { outcome, first: events[before], all: events.slice(before) }
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

// ================= 2. 锚定：说明里的词不再授予权限 =================
{
  // 说明写着 git push，命令是 node scripts/verify.mjs（无绝对路径 → 定域 unknown，不会被定域放行兜住）
  const state = boot()
  const r = await decide(state, 's1', 'git push 需要访问 Windows 凭据管理器', 'pwsh', { command: 'node scripts/verify.mjs' })
  assert.notStrictEqual(r.first.verdict, 'rule',
    'contains:"git" must not fire on the model\'s prose alone')
  assert.strictEqual(state.streamCalls, 1, 'the call falls through to the judge instead')
  console.log('  ✓ 锚定：说明里写「git push」但命令是 node 脚本 → 规则不命中（走判定器）')

  // 对照：命令里真的有 git → 内置 contains:"git" 规则照常命中
  const state2 = boot()
  const r2 = await decide(state2, 's2', '同步远端', 'pwsh', { command: 'git status --short' })
  assert.strictEqual(r2.first.verdict, 'rule', 'a command that really contains "git" still matches the rule')
  assert.strictEqual(state2.streamCalls, 0, 'and the judge is never called')
  console.log('  ✓ 锚定：命令里真的有 git → 规则照常命中（不放宽也不误伤）')

  // 锚定为空（没命令、没目标）→ 含 contains 的规则不匹配（fail-closed）
  const state3 = boot()
  const r3 = await decide(state3, 's3', 'git push 需要凭据管理器', 'pwsh', {})
  assert.notStrictEqual(r3.first.verdict, 'rule', 'an empty anchor must not match a contains rule')
  assert.strictEqual(state3.streamCalls, 1, 'it goes to the judge')
  console.log('  ✓ 锚定：看不见真实操作（空锚定）→ 含 contains 的规则不命中（fail-closed）')
}

// ================= 3. 敏感路径永远人工（连规则也盖不过） =================
{
  const state = boot({ allowRules: [{ tool: 'pwsh', contains: 'git', description: '宽规则（测试）' }] })
  // 绝对路径形态：`~/.ssh/id_rsa`（定域与敏感层都只认绝对路径字面量）
  const r = await decide(state, 's4', '读一下密钥', 'pwsh', { command: 'git show HEAD -- ~/.ssh/id_rsa' })
  assert.strictEqual(r.first.kind, 'manual-pending', 'touching a private key always goes to a human')
  assert.strictEqual(r.first.path, 'sensitive-path', 'the sensitive-path layer owns the decision')
  assert.strictEqual(state.streamCalls, 0, 'and the judge is not consulted')
  console.log('  ✓ 敏感路径：命中即人工，连白名单宽规则也盖不过，判定器零调用')

  // 工作区内的相对写目标也要命中（write/edit 的 file_path 会被解析成绝对路径再定域）
  const state1b = boot()
  const r1b = await decide(state1b, 's4b', '写环境变量', 'write', { file_path: join(WORKSPACE, '.env') })
  assert.strictEqual(r1b.first.path, 'sensitive-path', 'a .env inside the workspace is still a sensitive path')
  console.log('  ✓ 敏感路径：工作区内的 .env（相对/区内写目标）同样永远人工')

  // 对照：普通源码文件不受影响
  const state2 = boot()
  const r2 = await decide(state2, 's5', '改一行', 'edit', { file_path: join(WORKSPACE, 'src', 'a.mjs') })
  assert.notStrictEqual(r2.first.path, 'sensitive-path', 'an ordinary source file is not a sensitive path')
  console.log('  ✓ 敏感路径：普通源码文件不受影响（不做全路径子串匹配）')
}

// ================= 4. $DSH_HOME 的命令类维护仍自动放行 =================
{
  const state = boot()
  const cmd = `Set-Location '${DSH_HOME}\\profiles\\desktop'; pnpm install --frozen-lockfile`
  const r = await decide(state, 's6', '更新插件依赖', 'pwsh', { command: cmd })
  assert.strictEqual(r.first.verdict, 'dsh-config',
    'a $DSH_HOME profile install stays auto-approved even though it is outside the workspace')
  assert.strictEqual(state.streamCalls, 0, 'the judge is not consulted')
  console.log('  ✓ $DSH_HOME：命令类工具的 profile / 依赖维护仍自动放行（补上 file_path 之外的缺口）')

  // 但审批门自身数据目录不在此列
  const state2 = boot()
  const r2 = await decide(state2, 's7', '改一下配置', 'pwsh', { command: `Set-Content '${DSH_HOME}\\auto-approve\\allowlist.json' -Value '{}'` })
  assert.strictEqual(r2.first.path, 'sensitive-path', "the gate's own data directory is never auto-approved")
  console.log('  ✓ $DSH_HOME：审批门自身数据目录仍永远人工（例外不被扩展档吞掉）')
}

// ================= 5. 工作区外 / 跨内外一律人工 =================
{
  const state = boot()
  const r = await decide(state, 's8', '跑外部脚本', 'pwsh', { command: `node ${OUTSIDE}\\tool.mjs` })
  assert.strictEqual(r.first.kind, 'manual-pending', 'an out-of-workspace target goes to a human')
  assert.strictEqual(r.first.path, 'outside', 'the outside layer owns the decision')
  assert.strictEqual(state.streamCalls, 0, 'the judge is not consulted')
  console.log('  ✓ 工作区外：目标含区外路径 → 人工（判定器零调用）')

  // mixed：区内 + 区外
  const state2 = boot()
  const r2 = await decide(state2, 's9', '备份配置', 'pwsh',
    { command: `Copy-Item ${WORKSPACE}\\a.txt ${OUTSIDE}\\a.txt` })
  assert.strictEqual(r2.first.targetScope, 'mixed', 'the target really straddles inside and outside')
  assert.strictEqual(r2.first.path, 'outside', 'mixed also goes to a human (one outside target is enough)')
  console.log('  ✓ 跨内外：只要有一个区外目标就人工')

  // 白名单排在它之前：用户手写的区外规则仍然生效
  // （contains 用目录名 `clash-verge-rev`：matchContains 要求命中落在词/路径边界上，
  //   `clash-verge` 后面紧跟 `-` 会被边界检查拒绝 —— 这是既有的边界语义，不是本步引入的）
  const outsideRule = { tool: 'edit', mode: 'danger-full-access', contains: 'clash-verge-rev', description: '用户手写：区外配置' }
  const state3 = boot({ allowRules: [outsideRule] })
  const r3 = await decide(state3, 's10', '改代理配置', 'edit', { file_path: join(OUTSIDE, 'clash-verge-rev', 'Merge.yaml') })
  assert.strictEqual(r3.first.verdict, 'rule', "a rule the user wrote for an outside path still applies ('一律' constrains the default posture, not the user's own rules)")
  assert.strictEqual(state3.streamCalls, 0, 'no judge call')
  console.log('  ✓ 工作区外：白名单排在它之前 —— 用户手写的区外规则仍生效')

  // 开关：关掉后退回判定器
  const state4 = boot({ outsideNeedsHuman: false })
  const r4 = await decide(state4, 's11', '跑外部脚本', 'pwsh', { command: `node ${OUTSIDE}\\tool.mjs` })
  assert.notStrictEqual(r4.first.path, 'outside', 'with the switch off the outside layer stands down')
  assert.strictEqual(state4.streamCalls, 1, 'and the request goes back to the judge')
  console.log('  ✓ 工作区外：开关可一键回退（退回判定器）')
}

// ================= 6. 回归护栏：工作区内仍走定域放行 =================
{
  const state = boot()
  const r = await decide(state, 's12', '跑项目自检', 'pwsh', { command: `cd ${WORKSPACE}\\repo; node scripts/verify.mjs` })
  assert.strictEqual(r.first.verdict, 'scope', 'an in-workspace target is still auto-allowed by scope')
  assert.strictEqual(state.streamCalls, 0, 'no judge call')
  console.log('  ✓ 回归护栏：工作区内目标仍走定域放行（第 ④ 步没有把它挤掉）')
}

// ================= 7. 追认写下的规则指纹来自命令，锚定后仍能命中 =================
{
  const state = boot()
  // 造一条可追认的静默拒绝事件（带真实命令）
  const ev = {
    id: 1, ts: new Date().toISOString(), sessionId: 's13',
    tool: 'pwsh', mode: 'danger-full-access', reason: 'r',
    justification: '跑一下项目的自检脚本，确认没有回归',
    verdict: 'judge-deny', kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    files: [], command: 'node scripts/verify.mjs --strict',
  }
  appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n', 'utf8')
  const res = await post(state, '/api/auto-approve/reconsider', { sessionId: 's13', eventId: 1, scope: 'session' })
  assert.strictEqual(res.payload.ok, true, 'the reconsider call succeeds: ' + JSON.stringify(res.payload).slice(0, 200))
  const written = (readCfg().allowRules || []).filter((r) => r.description && r.description.indexOf('用户追认') >= 0)
  assert.strictEqual(written.length, 1, 'exactly one reconsideration rule is written')
  const fp = String(written[0].contains || '')
  assert.ok(fp.indexOf('scripts/verify.mjs') >= 0 || fp.indexOf('verify.mjs') >= 0 || (written[0].keywords || []).some((k) => String(k).indexOf('verify.mjs') >= 0),
    'the fingerprint comes from the command, not from the prose: ' + JSON.stringify(written[0]))

  // 同一条命令再跑一次：锚定后的白名单层应当命中
  const r = await decide(state, 's13', '再跑一次自检', 'pwsh', { command: 'node scripts/verify.mjs --strict' })
  assert.strictEqual(r.first.verdict, 'rule', 'the reconsideration rule matches an anchored context')
  assert.strictEqual(state.streamCalls, 0, 'no judge call for the re-approved command')
  console.log('  ✓ 追认：规则指纹取自命令（不是措辞），锚定后的白名单层仍能命中')
}

console.log('All step ④ tests passed successfully!')
