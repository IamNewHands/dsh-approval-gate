/**
 * 全量设置导出 / 导入端点（GET /api/auto-approve/export、POST /api/auto-approve/import）回归测试。
 *
 * 与 models-endpoint.test.mjs 同法：模拟宿主执行真实注册的 HTTP 处理器，因此同时验证
 * 「apply() 能把这批路由挂上」（宿主插件 apply 抛错在 dsh web 下可能完全不可见，
 * 只表现为端点静默缺失）与端点的行为契约：
 *   1. 两个路由都注册成功，且与其余 /api/auto-approve/* 同一套凭据围栏
 *   2. GET /export 返回可直接导入的设置包；POST /import 落盘并返回计数与备份路径
 *   3. 非法输入 400、方法不符 405（不是 500，也不静默成功）
 *   4. 导入的裁判模型 provider 不在本机注册路由时给出警告（判定会失败转人工）
 *
 * 用临时 DSH_HOME 隔离，绝不触碰真实 ~/.dsh/auto-approve。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-export-route-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
mkdirSync(dataDir, { recursive: true })
const allowlistPath = join(dataDir, 'allowlist.json')

writeFileSync(allowlistPath, JSON.stringify({
  version: 4,
  denyKeywords: ['rm -rf'],
  allowRules: [{ tool: 'write', contains: 'route-test-local', description: '本机规则' }],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 3,
  judgeTimeoutMs: 20000,
  judgeFailureLimit: 1,
  judgeMaxTokens: 1024,
  learning: { enabled: false },
}, null, 2) + '\n', 'utf8')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const plugin = (await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())).default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing export/import endpoints...')

const EXPORT_ROUTE = '/api/auto-approve/export'
const IMPORT_ROUTE = '/api/auto-approve/import'

function makeCtx(options = {}) {
  const state = { routes: new Map() }
  const ctx = {
    llm: Object.assign({
      stream: () => { throw new Error('judge must not be called in this test') },
      listProviders: () => options.providers || [],
      listModels: async () => [],
    }, options.llm || {}),
    permissionPresets: options.permissionPresets || { current: () => 'auto-approve' },
    connection: options.connection,
    get: () => undefined,
    webServer: { register: (spec) => { state.routes.set(spec.path, spec); return () => {} } },
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    on: () => () => {},
  }
  return { ctx, state }
}

/** 假请求：POST 时按宿主行为异步投递 body（readBody 的监听器在 handler 内同步注册） */
function fakeReq(path, method, body) {
  const handlers = {}
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:43120' },
    destroy: () => {},
    on: (event, fn) => {
      handlers[event] = handlers[event] || []
      handlers[event].push(fn)
      return req
    },
  }
  if (body !== undefined) {
    setImmediate(() => {
      for (const fn of handlers.data || []) fn(Buffer.from(JSON.stringify(body)))
      for (const fn of handlers.end || []) fn()
    })
  }
  return req
}

function fakeRes() {
  const res = { status: 0, payload: null, headers: null }
  res.writeHead = (code, headers) => { res.status = code; res.headers = headers || null }
  res.end = (text) => { try { res.payload = JSON.parse(text) } catch { res.payload = text } }
  return res
}

async function call(state, path, method, body) {
  const route = state.routes.get(path)
  assert.ok(route, `route ${path} must be registered`)
  const res = fakeRes()
  await route.handler(fakeReq(path, method, body), res)
  return res
}

const readAllowlist = () => JSON.parse(readFileSync(allowlistPath, 'utf8'))
const hasRule = (list, partial) => (list || []).some((x) =>
  Object.keys(partial).every((k) => (x[k] || '') === (partial[k] || '')))

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log('  ✓ ' + name)
  } catch (error) {
    failures += 1
    console.error('  ✗ ' + name + '\n      ' + String((error && error.message) || error))
  }
}

// ================= 1. 注册与导出 =================
const main = makeCtx({ providers: [{ id: 'deepseek-official' }] })
plugin.apply(main.ctx)

let exportedBundle = null

await check('两个路由都注册成功', () => {
  assert.ok(main.state.routes.has(EXPORT_ROUTE), 'export route must be registered')
  assert.ok(main.state.routes.has(IMPORT_ROUTE), 'import route must be registered')
})

await check('GET /export 返回设置包，且带下载文件名', async () => {
  const res = await call(main.state, EXPORT_ROUTE, 'GET')
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.payload.kind, 'dsh-approval-gate-settings')
  assert.strictEqual(res.payload.bundleVersion, 1)
  assert.strictEqual(res.payload.config.riskyThreshold, 3)
  assert.match(String(res.headers['content-disposition']), /attachment; filename="dsh-approval-gate-settings-/)
  exportedBundle = res.payload
})

await check('POST /export 返回 405（方法不符不静默成功）', async () => {
  const res = await call(main.state, EXPORT_ROUTE, 'POST')
  assert.strictEqual(res.status, 405)
})

// ================= 2. 导入 =================
await check('POST /import 合并导入并落盘，返回计数与备份路径', async () => {
  const res = await call(main.state, IMPORT_ROUTE, 'POST', {
    bundle: exportedBundle,
    mode: 'merge',
    importLearning: false,
  })
  assert.strictEqual(res.status, 200, JSON.stringify(res.payload))
  assert.strictEqual(res.payload.ok, true)
  assert.strictEqual(res.payload.mode, 'merge')
  assert.ok(existsSync(res.payload.backupPath), '备份文件必须存在')
  const after = readAllowlist()
  assert.ok(hasRule(after.allowRules, { tool: 'write', contains: 'route-test-local' }), '本机规则必须保留')
  assert.ok(res.payload.applied && res.payload.applied.rules, '必须返回规则计数')
})

await check('GET /import 返回 405', async () => {
  const res = await call(main.state, IMPORT_ROUTE, 'GET')
  assert.strictEqual(res.status, 405)
})

await check('非法设置包返回 400 + ok:false', async () => {
  const res = await call(main.state, IMPORT_ROUTE, 'POST', { bundle: { kind: 'nope', config: {} } })
  assert.strictEqual(res.status, 400)
  assert.strictEqual(res.payload.ok, false)
  assert.match(String(res.payload.error), /不是 dsh-approval-gate 的设置包/)
})

await check('缺少 bundle 字段返回 400（不抛 500）', async () => {
  const res = await call(main.state, IMPORT_ROUTE, 'POST', { mode: 'merge' })
  assert.strictEqual(res.status, 400)
  assert.strictEqual(res.payload.ok, false)
})

// ================= 3. 凭据 / 来源围栏 =================
await check('connection 拒绝（401）时两个端点都拒绝', async () => {
  const guarded = makeCtx({ connection: { requestRejection: () => 401 } })
  plugin.apply(guarded.ctx)
  const resExport = await call(guarded.state, EXPORT_ROUTE, 'GET')
  const resImport = await call(guarded.state, IMPORT_ROUTE, 'POST', { bundle: exportedBundle })
  assert.strictEqual(resExport.status, 401)
  assert.strictEqual(resImport.status, 401)
  assert.strictEqual(resImport.payload.ok, false)
})

await check('来源不可信（403）时导入被拒', async () => {
  const guarded = makeCtx({ connection: { requestRejection: () => 403 } })
  plugin.apply(guarded.ctx)
  const res = await call(guarded.state, IMPORT_ROUTE, 'POST', { bundle: exportedBundle })
  assert.strictEqual(res.status, 403)
})

// ================= 4. 裁判模型警告 =================
await check('导入的裁判模型 provider 未在本机注册 → 返回警告', async () => {
  const bundle = JSON.parse(JSON.stringify(exportedBundle))
  bundle.config.judgeModel = { provider: 'provider-from-other-machine', model: 'flash-x' }
  const res = await call(main.state, IMPORT_ROUTE, 'POST', { bundle, mode: 'merge' })
  assert.strictEqual(res.status, 200, JSON.stringify(res.payload))
  assert.ok(res.payload.warnings.some((w) => w.includes('未在本机注册')), JSON.stringify(res.payload.warnings))
})

await check('provider 已注册时不产生该警告', async () => {
  const bundle = JSON.parse(JSON.stringify(exportedBundle))
  bundle.config.judgeModel = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const res = await call(main.state, IMPORT_ROUTE, 'POST', { bundle, mode: 'merge' })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.payload.warnings.some((w) => w.includes('未在本机注册')), false)
})

if (failures > 0) {
  console.error(`export-import route: ${failures} 项失败`)
  process.exit(1)
}
console.log('export-import route: all assertions passed')
