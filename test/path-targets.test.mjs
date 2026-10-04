/**
 * 目标定域（② 修 pwsh 路径提取）—— 纯函数 + 管道落库两层验证。
 *
 * 取证背景（2026-10-04，_port-analysis/p01-digest6.md D 段）：
 * 原先只有一条宽松正则，`cd D:\GitHub_Clone\x; git push origin main` 里的绝对路径提不出来，
 * 记录到的「目标」反而是说明措辞里的相对片段（`IamNewHands/dsh-approval-gate`、`origin/main`、
 * `.git/objects`）。628 条带命令的真实事件里 458 条（73%）因此无法回答
 * 「这次操作动的是工作区内还是工作区外」—— 而「减少人工审批」的下一步
 * （工作区内自动放行）正是建立在这个答案之上。
 *
 * 本文件锁定的不变量：
 *   1. 只认绝对路径字面量；相对片段、URL、命令选项一律不进目标列表。
 *   2. 引号内的整段优先（含空格的路径不能被截成 `C:\Program`）。
 *   3. 系统程序位置与设备伪文件不算数据目标（否则 `bash.exe` 会把调用误判成「工作区外」）。
 *   4. `..` 穿越时「工作区内」不可信 → 降级为 unknown（fail-closed）。
 *   5. 一个 data 目标都没有 → unknown，**不是** inside。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-targets-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
mkdirSync(dataDir, { recursive: true })
// 工作区与 DSH_HOME 必须是不同的目录树（同 pipeline.test.mjs）
const WORKSPACE = join(tempHome, 'ws')
mkdirSync(WORKSPACE, { recursive: true })

writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify({
  version: 4,
  denyKeywords: ['rm -rf'],
  allowRules: [],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 2,
  judgeTimeoutMs: 300,
  // 本文件测「目标提取 / 定域 / 判定器载荷」，不测定域放行：关掉 0.9.7 的放行层，
  // 否则工作区内的调用会在到达判定器之前被放行，7a2 的载荷断言测不到。
  // 定域放行与危险动作围栏由 test/fence-scope.test.mjs 覆盖。
  scopeAutoAllow: false,
  learning: { enabled: true },
}, null, 2) + '\n', 'utf8')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())
const paths = await import(pathToFileURL(join(REPO_ROOT, 'src', 'paths.mjs')).href + '?t=' + Date.now())
const plugin = mod.default
const { extractAbsolutePaths, classifyPathScope, hasPathTraversal, resolveRoots, normalizePath } = paths

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing absolute-path target extraction...')

const roots = resolveRoots(WORKSPACE, { dshHome: DSH_HOME })
const dataTargets = (text) => extractAbsolutePaths(text).filter((p) => p.kind === 'data')
const scopeOf = (text) => {
  const base = classifyPathScope(extractAbsolutePaths(text), roots)
  if (base.scope === 'inside' && hasPathTraversal(text)) return Object.assign({}, base, { scope: 'unknown' })
  return base
}
/** 规范化后比较（win32 一律小写），避免测试里手写大小写差异 */
const norm = (p) => normalizePath(p, WORKSPACE, roots.home)

// ================= 1. 真实命令样本：`cd` 里的绝对路径必须被提出来 =================
{
  const cmd = 'cd D:\\GitHub_Clone\\dsh-approval-gate; git -c http.sslBackend=openssl push origin main 2>&1 | Select-Object -Last 4'
  const got = extractAbsolutePaths(cmd)
  assert.strictEqual(got.length, 1, `only the real path may be extracted, got ${JSON.stringify(got)}`)
  assert.strictEqual(got[0].raw, 'D:\\GitHub_Clone\\dsh-approval-gate')
  assert.strictEqual(got[0].kind, 'data')
  // 回归护栏：这些相对片段曾经被当成「目标」
  for (const junk of ['origin/main', 'Select-Object', 'IamNewHands/dsh-approval-gate']) {
    assert.ok(!got.some((p) => p.raw.includes(junk)), `${junk} must not be a target`)
  }
  console.log('  ✓ cd 到工作区仓库 + git push：只提出绝对路径，相对片段不再冒充目标')
}

// ================= 2. 相对片段与 URL 一律不进目标列表 =================
{
  assert.deepStrictEqual(dataTargets('git push origin main'), [], 'no absolute path → no data target')
  assert.deepStrictEqual(dataTargets('git push origin refs/heads/main'), [], 'refs/heads/main is not a path')
  assert.deepStrictEqual(dataTargets('需要写入 .git/objects 完成提交'), [], '.git/objects is relative')
  assert.deepStrictEqual(dataTargets('推送修复到 IamNewHands/TiebaPure-iOS 的 main 分支'), [],
    'owner/repo prose is not a path')
  assert.deepStrictEqual(dataTargets('curl -s https://api.github.com/repos/IamNewHands/x'), [],
    'a URL path segment must not become a filesystem target')
  assert.deepStrictEqual(dataTargets('gh run download 36217621315 -n ipa -D $dir'), [],
    'a variable target is unknown, not inside')
  console.log('  ✓ 相对片段 / URL / 变量目标：一律不产出 data 目标（fail-closed）')
}

// ================= 3. 引号内整段优先（含空格的路径） =================
{
  const cmd = "& 'C:\\Program Files\\Git\\bin\\bash.exe' /d/GitHub_Clone/_port-analysis/dryrun.sh 2>&1"
  const got = extractAbsolutePaths(cmd)
  assert.ok(!got.some((p) => p.raw === 'C:\\Program'),
    'the quoted span must not be truncated at the first space')
  const exe = got.find((p) => /bash\.exe$/i.test(p.raw))
  assert.ok(exe, 'the quoted executable is extracted whole')
  assert.strictEqual(exe.kind, 'program', 'a system program location is not a data target')
  const msys = got.find((p) => p.kind === 'data')
  assert.strictEqual(msys.path, norm('D:\\GitHub_Clone\\_port-analysis\\dryrun.sh'),
    'git-bash /d/... is folded onto the D: drive before comparison')
  assert.strictEqual(scopeOf(cmd).scope, 'outside',
    'the bash script lives outside this temp workspace → outside (the program path is not counted)')
  assert.strictEqual(scopeOf("& 'C:\\Program Files\\Git\\bin\\bash.exe' --version").scope, 'unknown',
    'when the only target is a system program, nothing is known about the data scope')
  console.log('  ✓ 引号内整段优先：含空格的路径不再被截断，/d/... 折算到 D:')
}

// ================= 4. 系统程序位置与设备伪文件不是数据目标 =================
{
  assert.deepStrictEqual(dataTargets('/usr/bin/env bash -n driver.sh'), [],
    'an interpreter location is not a data target')
  const dev = extractAbsolutePaths('node x.mjs 2> /dev/null')
  assert.ok(dev.every((p) => p.kind === 'device'), `/dev/null must be a device, got ${JSON.stringify(dev)}`)
  assert.deepStrictEqual(dataTargets('Remove-Item -Recurse -Force D:\\ws\\_tmp\\probe'),
    [extractAbsolutePaths('D:\\ws\\_tmp\\probe')[0]], 'a real in-workspace delete target is kept')
  console.log('  ✓ 解释器位置 / /dev/null 不算数据目标；真实删除目标保留')
}

// ================= 5. 定域四态：inside / outside / mixed / unknown =================
{
  const ws = WORKSPACE
  const inside = scopeOf(`cd "${ws}"\\repo; git log --oneline -3`)
  assert.strictEqual(inside.scope, 'inside')
  assert.strictEqual(inside.outside.length, 0)

  const outside = scopeOf('Get-Content "C:\\Users\\shiro\\AppData\\Roaming\\x\\profiles\\Merge.yaml"')
  assert.strictEqual(outside.scope, 'outside')
  assert.strictEqual(outside.inside.length, 0)

  const mixed = scopeOf(`$src='${ws}\\a'; $dst='C:\\Users\\shiro\\.dsh\\profiles\\desktop'; Copy-Item $src $dst`)
  assert.strictEqual(mixed.scope, 'mixed')
  assert.strictEqual(mixed.inside.length, 1)
  assert.strictEqual(mixed.outside.length, 1)

  assert.strictEqual(scopeOf('git -c http.sslBackend=openssl push origin main 2>&1').scope, 'unknown',
    'no absolute path at all → unknown (must never be read as inside)')
  assert.strictEqual(classifyPathScope([], roots).scope, 'unknown')
  console.log('  ✓ 定域四态：inside / outside / mixed / unknown 各自成立')
}

// ================= 6. `..` 穿越 → inside 降级为 unknown =================
{
  const escaping = `cd ${WORKSPACE}\\x; Get-Content ..\\..\\Users\\shiro\\.ssh\\id_rsa`
  assert.ok(hasPathTraversal(escaping), 'a `..` segment is detected')
  assert.ok(!hasPathTraversal(`${WORKSPACE}\\a..b\\c.txt`), '`..` inside a filename is not traversal')
  assert.strictEqual(scopeOf(escaping).scope, 'unknown',
    'literal paths say "inside" but the traversal escapes → must degrade to unknown')
  console.log('  ✓ .. 穿越：字面量全在工作区内也降级为 unknown（不许报 inside）')
}

// ================= 7. 管道：目标定域落进事件与中文说明 =================
{
  const state = { handler: null, llmCalls: [] }
  const ctx = {
    llm: {
      stream(options) {
        const userMsg = (options.messages || []).map((m) => (m.content || []).map((b) => b.text || '').join('')).join('')
        state.llmCalls.push({ system: options.system, user: userMsg })
        return (async function* () {
          yield { type: 'text-delta', text: '{"decision":"allow","reason":"ok","category":"neutral"}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    permissionPresets: { current: () => 'auto-approve' },
    get: () => undefined,
    webServer: undefined,
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    on: (name, handler) => { if (name === 'approval/request') state.handler = handler; return () => {} },
  }
  plugin.apply(ctx)
  assert.ok(state.handler, 'plugin must register an approval/request handler')

  const eventsPath = join(dataDir, 'events.jsonl')
  const lastEvent = () => {
    const lines = readFileSync(eventsPath, 'utf8').trim().split('\n')
    return JSON.parse(lines[lines.length - 1])
  }
  const decide = async (req) => state.handler(req, async () => 'allowed-once')
  const makeReq = ({ sessionId, toolName, justification, args, callId }) => ({
    callId,
    toolName,
    reason: `escalate sandbox to danger-full-access: ${justification}`,
    agent: {
      session: {
        id: sessionId,
        header: { cwd: WORKSPACE },
        snapshotEvents: () => [
          { type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(args) } },
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请完成这个任务' }] } },
        ],
      },
    },
  })

  // 7a. 工作区内 git 命令：绝对路径进事件、进 facts、进判定器输入
  {
    const repo = join(WORKSPACE, 'repo')
    const cmd = `cd ${repo}; git -c http.sslBackend=openssl push origin main 2>&1 | Select-Object -Last 4`
    const req = makeReq({
      sessionId: 's-target-inside',
      toolName: 'pwsh',
      justification: '推送修复到 IamNewHands/dsh-approval-gate 的 main 分支。',
      args: { command: cmd },
      callId: 't1',
    })
    await decide(req)
    const ev = lastEvent()
    assert.strictEqual(ev.targetScope, 'inside', 'the recorded event knows the targets are in-workspace')
    assert.ok(Array.isArray(ev.targets) && ev.targets.some((t) => norm(t) === norm(repo)),
      `the absolute repo path is recorded, got ${JSON.stringify(ev.targets)}`)
    assert.ok(!(ev.targets || []).some((t) => /IamNewHands/.test(t)),
      'the prose fragment from the justification never becomes a target')
    assert.strictEqual(ev.facts.targetScopeText, '工作区内', 'the field table states it in plain Chinese')
    assert.ok(!ev.targetTraversal)
    console.log('  ✓ 管道：工作区内命令 → targetScope=inside，绝对路径进事件与 facts')
  }

  // 7a2. 判定器输入：命令里的绝对路径终于进了 filesystemEffects
  //      （内置 contains:"git" 规则会先放行 git 命令，所以这里换一条不命中任何规则的命令，
  //       确保真的走到判定层）
  {
    const repo = join(WORKSPACE, 'repo')
    const out = join(WORKSPACE, 'out', 'report.json')
    const req = makeReq({
      sessionId: 's-target-judge',
      toolName: 'pwsh',
      justification: '生成构建报告。',
      args: { command: `cd ${repo}; node scripts/verify.mjs --out "${out}"` },
      callId: 't1b',
    })
    await decide(req)
    assert.ok(state.llmCalls.length > 0, 'the call reached the judge model')
    const payload = state.llmCalls[state.llmCalls.length - 1].user
    // 判定器载荷是 JSON，Windows 反斜杠被转义，比较前先按同样规则转义
    const esc = (p) => JSON.stringify(p).slice(1, -1)
    assert.ok(payload.includes(esc(repo)), `the judge sees the command target dir, payload=${payload.slice(0, 400)}`)
    assert.ok(payload.includes(esc(out)), 'the judge sees the quoted output path too')
    console.log('  ✓ 判定器输入：命令里的绝对路径进入 filesystemEffects（判定器不再只凭措辞猜）')
  }

  // 7b. 工作区外目标：必须报 outside，不许被说明措辞掩盖
  {
    const outsideFile = join(tempHome, 'AppData', 'Merge.yaml')
    const req = makeReq({
      sessionId: 's-target-outside',
      toolName: 'pwsh',
      justification: '备份并写入工作区外的 Clash 全局覆写配置。',
      args: { command: `Copy-Item "${outsideFile}" "${outsideFile}.bak" -Force` },
      callId: 't2',
    })
    await decide(req)
    const ev = lastEvent()
    assert.strictEqual(ev.targetScope, 'outside')
    assert.ok((ev.targets || []).some((t) => norm(t) === norm(outsideFile)))
    assert.ok(/工作区外/.test(ev.facts.targetScopeText), 'the field table says 工作区外')
    console.log('  ✓ 管道：工作区外目标 → targetScope=outside 并写进字段表格')
  }

  // 7c. 无绝对路径 + `..` 穿越：降级 unknown，并留下穿越标记
  {
    const req = makeReq({
      sessionId: 's-target-traversal',
      toolName: 'pwsh',
      justification: '读取上级目录里的配置。',
      args: { command: `cd ${WORKSPACE}\\x; Get-Content ..\\..\\Users\\shiro\\.ssh\\id_rsa` },
      callId: 't3',
    })
    await decide(req)
    const ev = lastEvent()
    assert.strictEqual(ev.targetScope, 'unknown', 'a traversal never reports inside')
    assert.strictEqual(ev.targetTraversal, true, 'the traversal is recorded for the audit')
    assert.ok(/无法定域/.test(ev.facts.targetScopeText))
    console.log('  ✓ 管道：.. 穿越 → targetScope=unknown + targetTraversal=true')
  }

  // 7d. 只读目标不给写快照：files 只装写目标，targets 才是「碰到了哪里」
  {
    const req = makeReq({
      sessionId: 's-target-readonly',
      toolName: 'pwsh',
      justification: '查看配置文件内容。',
      args: { command: `Get-Content "${join(WORKSPACE, 'a.txt')}"` },
      callId: 't4',
    })
    await decide(req)
    const ev = lastEvent()
    assert.ok(Array.isArray(ev.targets) && ev.targets.length > 0, 'a read target is still recorded')
    assert.ok(!Array.isArray(ev.files) || !ev.files.some((f) => /a\.txt$/.test(f)),
      'but it must NOT be treated as a write target (that would snapshot the file)')
    console.log('  ✓ 管道：只读目标只进 targets，不进 files（不会给敏感文件拍快照）')
  }
}

console.log('All absolute-path target tests passed successfully!')
