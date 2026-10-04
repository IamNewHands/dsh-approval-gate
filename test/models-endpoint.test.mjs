/**
 * 模型目录端点（GET /api/auto-approve/models）回归测试。
 *
 * 需求来源：设置页的「裁判模型」下拉框要与 DSH 对话框右下角的模型选择器同源，
 * 因此 host 侧必须把 llm 服务的路由与模型目录转发给前端。锁定的契约：
 *   1. 只列 listProviders() 的路由（已注册 adapter 的、真的调得通的）。
 *   2. 单个 provider 的目录失败只影响它自己（进 failures），其余路由照常可选。
 *   3. 目录不可用一律返回 200 + 空列表 + reason，**不是 5xx**——前端据此退化为
 *      「手填 provider/model」。判定模型选错会让每次审批都转人工，正是最需要用户
 *      自己改的时候，不能因为目录拉不到就把配置入口一起关掉。
 *   4. 端点与其余 /api/auto-approve/* 一样受凭据围栏保护（issue #12）。
 *
 * 断言针对 src/index.mjs 的真实实现（模拟宿主执行注册的 HTTP 处理器），
 * 用临时 DSH_HOME 隔离，绝不触碰真实 ~/.dsh/auto-approve。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-models-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
mkdirSync(dataDir, { recursive: true })

writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify({
  version: 4,
  judgeModel: { provider: 'ai-gateway', model: 'sensenova/deepseek-v4-flash' },
  denyKeywords: [],
  allowRules: [],
  denyRules: [],
  hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
  riskyThreshold: 3,
  judgeTimeoutMs: 20000,
  learning: { enabled: false },
}, null, 2) + '\n', 'utf8')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const plugin = (await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())).default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing model catalog endpoint...')

const ROUTE = '/api/auto-approve/models'

/** 模拟宿主：llm/adapter 目录由调用方给出，HTTP 路由被捕获后手动执行。 */
function makeCtx(llmOverride, connection) {
  const state = { routes: new Map() }
  const ctx = {
    llm: Object.assign({ stream: () => { throw new Error('judge must not be called in this test') } }, llmOverride || {}),
    permissionPresets: { current: () => 'auto-approve' },
    connection,
    get: () => undefined,
    webServer: { register: (spec) => { state.routes.set(spec.path, spec); return () => {} } },
    inject: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    on: () => () => {},
  }
  return { ctx, state }
}

function fakeReq(method) {
  return {
    method,
    url: ROUTE,
    headers: { host: '127.0.0.1:43120' },
    on: () => {},
  }
}

function fakeRes() {
  const res = { status: 0, payload: null }
  res.writeHead = (code) => { res.status = code }
  res.end = (text) => { try { res.payload = JSON.parse(text) } catch { res.payload = text } }
  return res
}

async function call(state, method) {
  const route = state.routes.get(ROUTE)
  assert.ok(route, `route ${ROUTE} must be registered`)
  const res = fakeRes()
  await route.handler(fakeReq(method), res)
  return res
}

// ================= 1. 路由已注册 =================
{
  const { ctx, state } = makeCtx({ listProviders: () => [], listModels: async () => [] })
  plugin.apply(ctx)
  const res = await call(state, 'GET')
  assert.equal(res.status, 200, 'GET must succeed')
  console.log('  ✓ 模型目录路由已注册')
}

// ================= 2. 正常目录：路由 + 各自模型 + 当前钉住的裁判模型 =================
{
  const catalog = {
    'deepseek-official': [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }],
    'ai-gateway': [
      { id: 'sensenova/deepseek-v4-flash', name: 'sensenova flash' },
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    ],
  }
  const { ctx, state } = makeCtx({
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
      { id: 'ai-gateway', name: 'AI Gateway' },
    ],
    listModels: async (id) => catalog[id],
  })
  plugin.apply(ctx)
  const res = await call(state, 'GET')
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.deepEqual(res.payload.providers.map((p) => p.id), ['deepseek-official', 'ai-gateway'],
    'every registered route is listed, in llm order')
  assert.equal(res.payload.providers[0].name, 'DeepSeek 官方', 'provider display name is forwarded')
  assert.deepEqual(res.payload.providers[1].models.map((m) => m.id),
    ['sensenova/deepseek-v4-flash', 'claude-sonnet-4.5'], 'each route carries its own models')
  assert.equal(res.payload.providers[1].models[1].name, 'Claude Sonnet 4.5', 'model display name is forwarded')
  assert.deepEqual(res.payload.current, { provider: 'ai-gateway', model: 'sensenova/deepseek-v4-flash' },
    'the pinned judge model is echoed so the UI can preselect it')
  console.log('  ✓ 目录可用：列出路由与模型，并回显当前裁判模型')
}

// ================= 3. 单个 provider 失败被隔离 =================
{
  const { ctx, state } = makeCtx({
    listProviders: () => [{ id: 'bad' }, { id: 'good', name: 'Good' }],
    listModels: async (id) => {
      if (id === 'bad') throw new Error('INVALID_CATALOG: adapter returned invalid model metadata')
      return [{ id: 'm1', name: 'M1' }]
    },
  })
  plugin.apply(ctx)
  const res = await call(state, 'GET')
  assert.equal(res.status, 200, 'one broken route must not fail the whole catalog')
  assert.equal(res.payload.providers.length, 2, 'the broken route is still listed (user may pin it anyway)')
  assert.equal(res.payload.providers[0].models.length, 0)
  assert.equal(res.payload.providers[1].models.length, 1, 'the healthy route keeps its models')
  assert.equal(res.payload.failures.length, 1)
  assert.equal(res.payload.failures[0].id, 'bad')
  assert.ok(/INVALID_CATALOG/.test(res.payload.failures[0].error), 'the reason is reported for diagnosis')
  console.log('  ✓ 单个 provider 目录失败被隔离，其余路由照常可选')
}

// ================= 4. 目录不可用 → 200 + 空列表（不是 5xx）=================
{
  // 旧版部署 / llm 服务未加载：只有 stream，没有 listProviders
  const { ctx, state } = makeCtx({})
  plugin.apply(ctx)
  const res = await call(state, 'GET')
  assert.equal(res.status, 200, 'a missing catalog must not surface as a server error')
  assert.equal(res.payload.ok, true)
  assert.deepEqual(res.payload.providers, [])
  assert.ok(res.payload.reason, 'a reason is given so the UI can explain the manual fallback')
  console.log('  ✓ 目录不可用 → 200 + 空列表 + reason（前端退化为手填）')
}

// ================= 5. 方法限制 =================
{
  const { ctx, state } = makeCtx({ listProviders: () => [], listModels: async () => [] })
  plugin.apply(ctx)
  const res = await call(state, 'POST')
  assert.equal(res.status, 405, 'the catalog is read-only')
  console.log('  ✓ 非 GET/HEAD → 405')
}

// ================= 6. 凭据围栏（issue #12）=================
{
  const { ctx, state } = makeCtx(
    { listProviders: () => [{ id: 'deepseek-official' }], listModels: async () => [{ id: 'm', name: 'M' }] },
    { requestRejection: () => 401 },
  )
  plugin.apply(ctx)
  const res = await call(state, 'GET')
  assert.equal(res.status, 401, 'an unauthenticated caller gets 401 before any catalog data')
  assert.equal(res.payload.providers, undefined, 'no route/model metadata leaks past the fence')
  console.log('  ✓ 凭据围栏：未授权请求 401，不泄露模型目录')
}

console.log('All model catalog endpoint tests passed successfully!')
