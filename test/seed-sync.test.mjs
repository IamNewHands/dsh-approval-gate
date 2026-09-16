/**
 * 多机共享规则 / 版本权威 / 旧字段迁移 的单元测试。
 *
 * 用独立的临时 DSH_HOME 动态导入真实模块，因此：
 *   - 验证的是 src/index.mjs 的真实实现，而非测试内重复的逻辑
 *   - 绝不读写用户真实的 ~/.dsh/auto-approve/allowlist.json
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SEED_PATH = join(REPO_ROOT, 'allowlist.json')
const SRC = pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href

console.log('Testing seed-sync / version / model-migration...')

const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'))
const sig = (r) => [r.tool || '', r.mode || '', r.category || '', r.contains || ''].join('\u0000')

/** 在隔离的 DSH_HOME 下导入真实模块，返回模块与写回的配置 */
async function bootWith(localConfig) {
  const tempHome = mkdtempSync(join(tmpdir(), 'ag-seedtest-'))
  const dataDir = join(tempHome, 'auto-approve')
  mkdirSync(dataDir, { recursive: true })
  const runtimePath = join(dataDir, 'allowlist.json')
  writeFileSync(runtimePath, JSON.stringify(localConfig, null, 2) + '\n', 'utf8')

  process.env.DSH_HOME = tempHome
  // 查询串避免 ESM 模块缓存，使每次导入都重新执行模块顶层逻辑
  const mod = await import(SRC + '?t=' + Date.now() + Math.random())
  const written = JSON.parse(readFileSync(runtimePath, 'utf8'))
  return { mod, written, tempHome, runtimePath }
}

const tempHomes = []
try {
  // ================= 启动路径：真实模块导入 =================
  const localConfig = {
    version: 3,
    denyKeywords: ['rm -rf', '本机自定义危险词'],
    allowRules: [
      { mode: 'workspace-write', description: '工作区写入（可回补，对应 acceptEdits/workspace-write）' },
      { tool: 'pwsh', contains: '本机专属工具', description: '本机自定义规则' },
    ],
    denyRules: [{ tool: 'pwsh', mode: 'danger-full-access', category: 'neutral', contains: '本机拒绝过的操作' }],
    hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
    riskyThreshold: 7,
    judgeTimeoutMs: 12345,
    model: { provider: 'ai-gateway', model: 'workbuddy/deepseek-v4-flash' },
    learning: { enabled: false },
  }
  const { mod, written, tempHome } = await bootWith(localConfig)
  tempHomes.push(tempHome)

  // ---- 1. 共享规则：种子里本地缺失的规则被并入 ----
  const haveAllow = new Set(written.allowRules.map(sig))
  const missingAllow = seed.allowRules.filter((r) => !haveAllow.has(sig(r)))
  assert.strictEqual(missingAllow.length, 0,
    `seed allowRules must all be merged in; missing: ${JSON.stringify(missingAllow)}`)

  const haveDeny = new Set(written.denyKeywords.map((x) => x.toLowerCase()))
  const missingDeny = seed.denyKeywords.filter((x) => !haveDeny.has(x.toLowerCase()))
  assert.strictEqual(missingDeny.length, 0,
    `seed denyKeywords must all be merged in; missing: ${JSON.stringify(missingDeny)}`)
  console.log(`  ✓ 共享规则已并入 (allow=${written.allowRules.length}, deny=${written.denyKeywords.length})`)

  // ---- 2. 本机自定义规则不被覆盖 ----
  assert.ok(written.denyKeywords.includes('本机自定义危险词'), 'machine-local denyKeyword must survive')
  assert.ok(written.allowRules.some((r) => r.contains === '本机专属工具'), 'machine-local allowRule must survive')
  assert.ok(written.denyRules.some((r) => r.contains === '本机拒绝过的操作'), 'machine-local denyRule must survive')
  console.log('  ✓ 本机自定义规则未被覆盖')

  // ---- 3. 机器本地设置不同步 ----
  assert.strictEqual(written.riskyThreshold, 7, 'riskyThreshold is machine-local')
  assert.strictEqual(written.judgeTimeoutMs, 12345, 'judgeTimeoutMs is machine-local')
  assert.strictEqual(written.learning.enabled, false, 'learning is machine-local')
  console.log('  ✓ 机器本地设置 (riskyThreshold/judgeTimeoutMs/learning) 未被同步覆盖')

  // ---- 4. 版本以仓库种子为准 ----
  assert.strictEqual(written.version, seed.version,
    `version must follow the repo seed (${seed.version}), got ${written.version}`)
  console.log(`  ✓ version 以仓库为准 = ${written.version}`)

  // ---- 5. 旧 model 字段迁移到 judgeModel，保留本机取值 ----
  assert.strictEqual(written.model, undefined, 'legacy `model` key must be removed after migration')
  assert.deepStrictEqual(written.judgeModel, { provider: 'ai-gateway', model: 'workbuddy/deepseek-v4-flash' },
    'legacy model must migrate to judgeModel preserving the machine-local value')
  console.log('  ✓ model → judgeModel 迁移完成，本机取值保留')

  // ---- 6. normalizeConfig 本身不合并种子（合并只在启动时做一次） ----
  // 若合并放进 normalizeConfig，reloadConfig()（每次审批前热更新）会把用户在 UI
  // 删除的种子规则反复复活。这里锁定该契约。
  // 注意：normalizeConfig 仍会补齐 5 条硬编码 DEFAULT_ALLOW_RULES（既有行为，与种子无关）。
  const bare = mod.normalizeConfig({ denyKeywords: ['只有本机词'], allowRules: [] })
  assert.strictEqual(bare.denyKeywords.length, 1,
    'normalizeConfig must NOT merge seed denyKeywords; merging is startup-only')
  const seedOnly = seed.allowRules.filter((r) => !mod.normalizeConfig({ allowRules: [] }).allowRules.some(
    (d) => sig(d) === sig(r)))
  assert.ok(seedOnly.length > 0, 'seed must contain rules beyond the hardcoded defaults (test precondition)')
  const leaked = seedOnly.filter((r) => bare.allowRules.some((b) => sig(b) === sig(r)))
  assert.strictEqual(leaked.length, 0,
    `normalizeConfig must NOT inject seed-only allowRules; leaked: ${JSON.stringify(leaked)}`)
  console.log(`  ✓ normalizeConfig 不合并种子（仅补 ${bare.allowRules.length} 条硬编码默认规则，未泄漏 ${seedOnly.length} 条种子专属规则）`)

  // ---- 7. mergeSharedRules 幂等 ----
  const once = JSON.parse(JSON.stringify(written))
  const twice = mod.mergeSharedRules(JSON.parse(JSON.stringify(once)), seed)
  assert.strictEqual(twice.allowRules.length, once.allowRules.length, 'merge must be idempotent (allowRules)')
  assert.strictEqual(twice.denyKeywords.length, once.denyKeywords.length, 'merge must be idempotent (denyKeywords)')
  console.log('  ✓ 合并幂等（重复合并不产生重复规则）')

  // ---- 8. 已显式配置 judgeModel 时，不被旧 model 覆盖 ----
  const explicit = mod.normalizeConfig({
    judgeModel: { provider: 'explicit-provider', model: 'explicit-model' },
    model: { provider: 'legacy-provider', model: 'legacy-model' },
  })
  assert.deepStrictEqual(explicit.judgeModel, { provider: 'explicit-provider', model: 'explicit-model' },
    'an explicit judgeModel must win over the legacy model field')
  assert.strictEqual(explicit.model, undefined, 'legacy key is still removed')
  console.log('  ✓ 显式 judgeModel 优先于旧 model 字段')

  // ---- 9. 空 judgeModel 时保留旧值；无 model 时不臆造 ----
  const noLegacy = mod.normalizeConfig({})
  assert.strictEqual(noLegacy.judgeModel, undefined, 'no legacy model -> no invented judgeModel')
  const emptyJm = mod.normalizeConfig({ judgeModel: { provider: '', model: '' }, model: { provider: 'p', model: 'm' } })
  assert.deepStrictEqual(emptyJm.judgeModel, { provider: 'p', model: 'm' },
    'an empty judgeModel is replaced by the legacy value')
  console.log('  ✓ judgeModel 缺失/为空时才用旧值，且不臆造默认值')

  // ---- 10. ruleKey 去重语义 ----
  assert.strictEqual(mod.ruleKey('denyKeywords', 'abc'), 'abc', 'string rules key by value')
  assert.strictEqual(
    mod.ruleKey('allowRules', { tool: 'pwsh', contains: 'git', description: 'x' }),
    mod.ruleKey('allowRules', { tool: 'pwsh', contains: 'git', description: 'different description' }),
    'object rules key by tool/mode/category/contains, ignoring description')
  console.log('  ✓ ruleKey 去重语义正确（忽略 description）')

  // ---- 11. 第二台机器（不同 provider 名）各自保留本机 judgeModel ----
  const machineB = await bootWith({
    version: 4,
    denyKeywords: [],
    allowRules: [],
    denyRules: [],
    hardCategories: [],
    riskyThreshold: 3,
    judgeTimeoutMs: 20000,
    model: { provider: 'my-own-gateway', model: 'custom/flash-model' },
    learning: { enabled: true },
  })
  tempHomes.push(machineB.tempHome)
  assert.deepStrictEqual(machineB.written.judgeModel, { provider: 'my-own-gateway', model: 'custom/flash-model' },
    'a different machine keeps its own provider/model name')
  assert.strictEqual(machineB.written.allowRules.length, seed.allowRules.length,
    'the second machine receives the shared ruleset')
  console.log('  ✓ 第二台机器保留本机 provider 名，同时获得共享规则')

  console.log('All seed-sync tests passed successfully!')
} finally {
  for (const h of tempHomes) { try { rmSync(h, { recursive: true, force: true }) } catch { /* ignore */ } }
}
