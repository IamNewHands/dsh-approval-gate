/**
 * 全量设置导出 / 导入（跨机器迁移）的单元测试。
 *
 * 与 seed-sync.test.mjs 同法：用独立的临时 DSH_HOME 动态导入真实模块，
 * 因此验证的是 src/index.mjs 的真实实现，且绝不读写用户真实的
 * ~/.dsh/auto-approve/allowlist.json。
 *
 * 「另一台机器」= 换一个 DSH_HOME 再导入一次模块（模块顶层的 DSH_HOME / DATA_DIR
 * 都是加载时求值的常量），于是两台机器是两个互不影响的模块实例。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href

console.log('Testing export/import (full settings bundle)...')

const tempHomes = []
let failures = 0

/** 造一台「机器」：独立的临时 DSH_HOME + 预置的 allowlist.json / learning.json */
async function bootMachine(allowlist, learning) {
  const home = mkdtempSync(join(tmpdir(), 'ag-export-'))
  tempHomes.push(home)
  const dataDir = join(home, 'auto-approve')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify(allowlist, null, 2) + '\n', 'utf8')
  if (learning) writeFileSync(join(dataDir, 'learning.json'), JSON.stringify(learning, null, 2) + '\n', 'utf8')
  process.env.DSH_HOME = home
  // 查询串避免 ESM 模块缓存：每次导入都重新执行顶层逻辑（也就重新绑定 DSH_HOME）
  const mod = await import(SRC + '?t=' + Date.now() + Math.random())
  return { mod, home, dataDir, allowlistPath: join(dataDir, 'allowlist.json') }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const sig = (r) => [r.tool || '', r.mode || '', r.category || '', r.contains || ''].join('\u0000')
/** 局部匹配：给出的字段逐个相等即算命中（其余字段不参与比较） */
const hasRule = (list, partial) => (list || []).some((x) =>
  Object.keys(partial).every((k) => (x[k] || '') === (partial[k] || '')))

const MACHINE_A_ALLOWLIST = {
  version: 4,
  denyKeywords: ['rm -rf', '机器A危险词'],
  allowRules: [
    { tool: 'edit', mode: 'danger-full-access', contains: 'appdata/roaming/rime', description: '机器A手写规则' },
    {
      tool: 'pwsh',
      mode: 'workspace-write',
      category: 'neutral',
      contains: 'session-only',
      description: '自动沉淀：机器A的会话规则',
      scope: 'session',
      sessionId: 'sess-A',
    },
  ],
  denyRules: [{ tool: 'pwsh', mode: 'danger-full-access', category: 'neutral', contains: '机器A拒绝过' }],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 5,
  judgeTimeoutMs: 33000,
  judgeFailureLimit: 2,
  judgeMaxTokens: 2048,
  judgeModel: { provider: 'provider-a', model: 'flash-a' },
  sedimentScope: 'global',
  scopeAutoAllow: false,
  outsideNeedsHuman: false,
  learning: { enabled: false },
  // 非白名单键：导出/导入都必须无视它
  evilKey: '不该被导出',
}

const MACHINE_A_LEARNING = {
  enabled: false,
  stats: { 'sess-A|edit|workspace-write|neutral': 2 },
  history: { 'sess-A|edit|workspace-write|neutral': [{ fp: 'a.md', ctx: '机器A的样本' }] },
}

const MACHINE_B_ALLOWLIST = {
  version: 4,
  denyKeywords: ['rm -rf', '机器B危险词'],
  allowRules: [{ tool: 'write', contains: 'machine-b-only', description: '机器B独有' }],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 9,
  judgeTimeoutMs: 20000,
  judgeFailureLimit: 1,
  judgeMaxTokens: 1024,
  learning: { enabled: true },
}

const MACHINE_B_LEARNING = {
  enabled: true,
  stats: { 'sess-B|write|danger-full-access|neutral': 2 },
  history: {},
}

const MACHINE_C_ALLOWLIST = {
  version: 4,
  denyKeywords: ['rm -rf', '机器C危险词'],
  allowRules: [{ tool: 'read', contains: 'machine-c-only', description: '机器C独有' }],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 4,
  learning: { enabled: true },
}

/** 断言辅助：失败只记录并继续，最后统一退出码 */
function check(name, fn) {
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (error) {
    failures += 1
    console.error('  ✗ ' + name + '\n      ' + String((error && error.message) || error))
  }
}

try {
  // ================= 机器 A：导出 =================
  const A = await bootMachine(MACHINE_A_ALLOWLIST, MACHINE_A_LEARNING)
  const bundleA = A.mod.buildSettingsBundle(null)

  check('导出包带 kind / 版本 / 溯源信息', () => {
    assert.strictEqual(bundleA.kind, 'dsh-approval-gate-settings')
    assert.strictEqual(bundleA.bundleVersion, 1)
    assert.match(String(bundleA.exportedAt), /^\d{4}-\d{2}-\d{2}T/)
    assert.match(String(bundleA.pluginVersion), /^\d+\.\d+\.\d+$/)
    assert.strictEqual(bundleA.source.platform, process.platform)
    assert.strictEqual(bundleA.preset.configured, false)
  })

  check('导出包含规则、判定参数与裁判模型', () => {
    const cfg = bundleA.config
    assert.ok(hasRule(cfg.allowRules, { tool: 'edit', contains: 'appdata/roaming/rime' }))
    assert.ok(hasRule(cfg.denyRules, { tool: 'pwsh', contains: '机器A拒绝过' }))
    assert.ok(cfg.denyKeywords.includes('机器A危险词'))
    assert.strictEqual(cfg.riskyThreshold, 5)
    assert.strictEqual(cfg.judgeTimeoutMs, 33000)
    assert.strictEqual(cfg.judgeFailureLimit, 2)
    assert.strictEqual(cfg.judgeMaxTokens, 2048)
    assert.deepStrictEqual(cfg.judgeModel, { provider: 'provider-a', model: 'flash-a' })
    assert.strictEqual(cfg.sedimentScope, 'global')
    assert.strictEqual(cfg.scopeAutoAllow, false)
    assert.strictEqual(cfg.outsideNeedsHuman, false)
    assert.strictEqual(cfg.learning.enabled, false)
  })

  check('导出包含学习进度，且不含非白名单键', () => {
    assert.strictEqual(bundleA.learning.stats['sess-A|edit|workspace-write|neutral'], 2)
    assert.strictEqual(bundleA.learning.history['sess-A|edit|workspace-write|neutral'][0].fp, 'a.md')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(bundleA.config, 'evilKey'), false)
  })

  check('导出包不含机器绝对路径', () => {
    const escapedHome = JSON.stringify(A.home).slice(1, -1)
    assert.strictEqual(JSON.stringify(bundleA).includes(escapedHome), false,
      'bundle must not leak the machine data dir / home path')
  })

  // ================= 消毒：直接打外部 JSON 的入口 =================
  check('sanitizeRuleList 丢弃非法/无效规则并收紧作用域', () => {
    const cleaned = A.mod.sanitizeRuleList([
      { tool: 'edit', contains: 'x', extra: 'drop-me' },
      { scope: 'session' }, // 无 sessionId：ruleScope 语义下永不生效 → 丢
      { scope: 'global', sessionId: 's1', tool: 'write' },
      'not-an-object',
      null,
      { tool: 'pwsh', keywords: ['a', 'a', 'b'] },
    ])
    assert.strictEqual(cleaned.length, 3, JSON.stringify(cleaned))
    assert.strictEqual(cleaned[0].extra, undefined)
    assert.strictEqual(cleaned[1].scope, 'global')
    assert.strictEqual(cleaned[1].sessionId, undefined)
    assert.deepStrictEqual(cleaned[2].keywords, ['a', 'b'])
  })

  check('sanitizeBundleConfig 只留白名单键与合法取值', () => {
    const cfg = A.mod.sanitizeBundleConfig({
      evilKey: 1,
      riskyThreshold: 0, // 下界外
      judgeTimeoutMs: 99999999, // 上界外
      judgeMaxTokens: 'abc',
      scopeAutoAllow: 'yes', // 非布尔
      sedimentScope: 'global-scope', // 非法枚举
      judgeModel: { provider: 'p', model: 'm' },
      allowRules: [],
    })
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg, 'evilKey'), false)
    assert.strictEqual(cfg.riskyThreshold, undefined)
    assert.strictEqual(cfg.judgeTimeoutMs, undefined)
    assert.strictEqual(cfg.judgeMaxTokens, undefined)
    assert.strictEqual(cfg.scopeAutoAllow, undefined)
    assert.strictEqual(cfg.sedimentScope, undefined)
    assert.deepStrictEqual(cfg.judgeModel, { provider: 'p', model: 'm' })
    assert.deepStrictEqual(cfg.allowRules, [])
  })

  // ================= 机器 B：合并导入 =================
  const B = await bootMachine(MACHINE_B_ALLOWLIST, MACHINE_B_LEARNING)
  const mergeResult = B.mod.importSettingsBundle(bundleA, { mode: 'merge' })

  check('合并导入成功并给出计数', () => {
    assert.strictEqual(mergeResult.ok, true, JSON.stringify(mergeResult))
    assert.strictEqual(mergeResult.mode, 'merge')
    assert.ok(mergeResult.applied.rules.allowRules.added >= 1)
    assert.ok(mergeResult.applied.rules.denyRules.added >= 1)
  })

  const bAfterMerge = readJson(B.allowlistPath)
  check('合并保留本机独有规则与危险词，并补齐导入包的规则', () => {
    assert.ok(hasRule(bAfterMerge.allowRules, { tool: 'write', contains: 'machine-b-only' }), '机器B独有规则被保留')
    assert.ok(hasRule(bAfterMerge.allowRules, { tool: 'edit', contains: 'appdata/roaming/rime' }), '机器A规则被并入')
    assert.ok(bAfterMerge.denyKeywords.includes('机器B危险词'))
    assert.ok(bAfterMerge.denyKeywords.includes('机器A危险词'))
    assert.ok(hasRule(bAfterMerge.denyRules, { tool: 'pwsh', contains: '机器A拒绝过' }))
  })

  check('合并导入同时同步判定参数与裁判模型', () => {
    assert.strictEqual(bAfterMerge.riskyThreshold, 5)
    assert.strictEqual(bAfterMerge.judgeTimeoutMs, 33000)
    assert.strictEqual(bAfterMerge.judgeFailureLimit, 2)
    assert.strictEqual(bAfterMerge.judgeMaxTokens, 2048)
    assert.deepStrictEqual(bAfterMerge.judgeModel, { provider: 'provider-a', model: 'flash-a' })
    assert.strictEqual(bAfterMerge.sedimentScope, 'global')
    assert.strictEqual(bAfterMerge.scopeAutoAllow, false)
    assert.strictEqual(bAfterMerge.outsideNeedsHuman, false)
    assert.strictEqual(bAfterMerge.learning.enabled, false)
  })

  check('默认不导入学习进度（本机学习状态保持原样）', () => {
    const learningOnDisk = readJson(join(B.dataDir, 'learning.json'))
    assert.strictEqual(learningOnDisk.stats['sess-B|write|danger-full-access|neutral'], 2)
    assert.strictEqual(learningOnDisk.stats['sess-A|edit|workspace-write|neutral'], undefined)
  })

  check('导入前留下可回滚备份（含导入前状态）', () => {
    assert.ok(mergeResult.backupPath && existsSync(mergeResult.backupPath), '备份文件必须存在')
    const backup = readJson(mergeResult.backupPath)
    assert.strictEqual(backup.kind, 'dsh-approval-gate-import-backup')
    assert.ok(hasRule(backup.allowlist.allowRules, { tool: 'write', contains: 'machine-b-only' }))
    assert.strictEqual(backup.allowlist.riskyThreshold, 9)
    assert.strictEqual(backup.learning.stats['sess-B|write|danger-full-access|neutral'], 2)
  })

  check('merge 幂等：再导一次不重复追加', () => {
    const again = B.mod.importSettingsBundle(bundleA, { mode: 'merge' })
    assert.strictEqual(again.ok, true)
    assert.strictEqual(again.applied.rules.allowRules.added, 0)
    assert.strictEqual(again.applied.rules.denyRules.added, 0)
    const list = readJson(B.allowlistPath).allowRules
    const hits = list.filter((r) => (r.tool || '') === 'edit' && (r.contains || '') === 'appdata/roaming/rime')
    assert.strictEqual(hits.length, 1, '同一条规则不能出现两次')
  })

  // ================= 机器 C：覆盖导入 =================
  const C = await bootMachine(MACHINE_C_ALLOWLIST, null)
  const replaceResult = C.mod.importSettingsBundle(bundleA, { mode: 'replace' })

  check('覆盖导入替换本机规则（本机独有规则消失）', () => {
    assert.strictEqual(replaceResult.ok, true)
    assert.strictEqual(replaceResult.mode, 'replace')
    const after = readJson(C.allowlistPath)
    assert.strictEqual(hasRule(after.allowRules, { tool: 'read', contains: 'machine-c-only' }), false,
      '覆盖模式必须丢掉本机独有规则')
    assert.ok(hasRule(after.allowRules, { tool: 'edit', contains: 'appdata/roaming/rime' }))
    assert.strictEqual(after.denyKeywords.includes('机器C危险词'), false)
    assert.ok(after.denyKeywords.includes('机器A危险词'))
  })

  // ================= 机器 D：会话规则提升为全局 =================
  const D = await bootMachine(MACHINE_C_ALLOWLIST, null)
  const sessionRule = { tool: 'pwsh', mode: 'workspace-write', category: 'neutral', contains: 'session-only' }

  check('默认导入保留会话作用域（会话 id 也一起进来）', () => {
    const after = readJson(C.allowlistPath)
    const hit = (after.allowRules || []).find((r) => sig(r) === sig(sessionRule))
    assert.ok(hit, '会话规则应被导入')
    assert.strictEqual(hit.sessionId, 'sess-A')
  })

  const globalizeResult = D.mod.importSettingsBundle(bundleA, { mode: 'merge', globalizeSession: true })

  check('globalizeSession 把会话规则提升为全局并统计条数', () => {
    assert.strictEqual(globalizeResult.ok, true)
    assert.ok(globalizeResult.applied.globalized >= 1)
    assert.ok(globalizeResult.warnings.some((w) => w.includes('提升为全局')))
    const after = readJson(D.allowlistPath)
    const hit = (after.allowRules || []).find((r) => sig(r) === sig(sessionRule))
    assert.ok(hit, '规则本体应被导入')
    assert.strictEqual(hit.scope, 'global')
    assert.strictEqual(hit.sessionId, undefined)
  })

  // ================= 机器 E：勾选导入学习进度 =================
  const E = await bootMachine(MACHINE_C_ALLOWLIST, MACHINE_B_LEARNING)
  const learningResult = E.mod.importSettingsBundle(bundleA, { mode: 'merge', importLearning: true })

  check('勾选后学习进度按设置包替换', () => {
    assert.strictEqual(learningResult.ok, true)
    assert.strictEqual(learningResult.applied.learning.stats, 1)
    const learningOnDisk = readJson(join(E.dataDir, 'learning.json'))
    assert.strictEqual(learningOnDisk.stats['sess-A|edit|workspace-write|neutral'], 2)
    assert.strictEqual(learningOnDisk.stats['sess-B|write|danger-full-access|neutral'], undefined)
    assert.strictEqual(learningOnDisk.history['sess-A|edit|workspace-write|neutral'][0].ctx, '机器A的样本')
  })

  // ================= 机器 F：只导规则（关掉判定参数） =================
  const F = await bootMachine(MACHINE_B_ALLOWLIST, null)
  const rulesOnly = F.mod.importSettingsBundle(bundleA, { mode: 'merge', importSettings: false })

  check('importSettings=false 时只动规则，判定参数保持本机值', () => {
    assert.strictEqual(rulesOnly.ok, true)
    assert.ok(rulesOnly.warnings.some((w) => w.includes('跳过了判定参数')))
    const after = readJson(F.allowlistPath)
    assert.strictEqual(after.riskyThreshold, 9)
    assert.strictEqual(after.judgeModel, undefined)
    assert.strictEqual(after.learning.enabled, true)
    assert.ok(hasRule(after.allowRules, { tool: 'edit', contains: 'appdata/roaming/rime' }))
  })

  // ================= 非法输入：必须拒绝且不落盘 =================
  const G = await bootMachine(MACHINE_B_ALLOWLIST, null)
  const beforeG = readFileSync(G.allowlistPath, 'utf8')

  check('拒绝非本插件的 JSON', () => {
    const res = G.mod.importSettingsBundle({ kind: 'something-else', config: {} })
    assert.strictEqual(res.ok, false)
    assert.match(res.error, /不是 dsh-approval-gate 的设置包/)
  })

  check('拒绝缺少 config 段的包', () => {
    const res = G.mod.importSettingsBundle({ kind: 'dsh-approval-gate-settings', bundleVersion: 1 })
    assert.strictEqual(res.ok, false)
    assert.match(res.error, /缺少 config 段/)
  })

  check('拒绝版本高于本插件支持的包', () => {
    const res = G.mod.importSettingsBundle({ kind: 'dsh-approval-gate-settings', bundleVersion: 99, config: {} })
    assert.strictEqual(res.ok, false)
    assert.match(res.error, /高于本插件支持的/)
  })

  check('拒绝非对象输入', () => {
    assert.strictEqual(G.mod.importSettingsBundle(null).ok, false)
    assert.strictEqual(G.mod.importSettingsBundle('nope').ok, false)
    assert.strictEqual(G.mod.importSettingsBundle([]).ok, false)
  })

  check('被拒绝的导入不写盘、不留备份', () => {
    assert.strictEqual(readFileSync(G.allowlistPath, 'utf8'), beforeG)
    const backups = readdirSync(G.dataDir).filter((f) => f.startsWith('import-backup-'))
    assert.strictEqual(backups.length, 0)
  })
} finally {
  for (const home of tempHomes) {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }
}

if (failures > 0) {
  console.error(`export-import: ${failures} 项失败`)
  process.exit(1)
}
console.log('export-import: all assertions passed')
