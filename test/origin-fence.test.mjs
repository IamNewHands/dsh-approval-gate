/**
 * API 来源围栏回归测试（上游 issue #4 P0-3 + #12）。
 *
 * 旧实现的来源校验只写 `u.hostname === host.split(':')[0]` —— 不比 scheme、不比端口，
 * 于是「名字相同」就能过：https 页面、任意端口、`javascript:` / `data:` 来源全部放行。
 * 本用例锁定收紧后的行为（全部走**退化路径**：ctx 不提供 connection 服务）。
 *
 * 有意保留的残余风险也在用例里显式断言：DNS rebinding 的页面与本地服务字面上同源
 * （Origin 与 Host 都是攻击者域名），任何基于 Origin 的比对都识别不出它——真正的防线是
 * connection.requestRejection 的凭据围栏，见最后一个用例。
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tempHome = mkdtempSync(join(tmpdir(), 'ag-origin-'))
const DSH_HOME = join(tempHome, 'dsh')
const dataDir = join(DSH_HOME, 'auto-approve')
mkdirSync(dataDir, { recursive: true })

writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify({
  version: 4,
  denyKeywords: [],
  allowRules: [],
  denyRules: [],
  hardCategories: ['deletion'],
  riskyThreshold: 3,
  judgeTimeoutMs: 20000,
  learning: { enabled: false },
}, null, 2) + '\n', 'utf8')

process.env.DSH_HOME = DSH_HOME
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const plugin = (await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.mjs')).href + '?t=' + Date.now())).default

process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

console.log('Testing API origin fence (fallback path)...')

const ROUTE = '/api/auto-approve/rules'

function makeCtx(connection) {
  const state = { routes: new Map() }
  const ctx = {
    llm: { stream: () => { throw new Error('judge must not be called') } },
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

function fakeReq(headers, extra) {
  return Object.assign({
    method: 'GET',
    url: ROUTE,
    headers,
    on: () => {},
  }, extra || {})
}

function fakeRes() {
  const res = { status: 0, payload: null }
  res.writeHead = (code) => { res.status = code }
  res.end = (text) => { try { res.payload = JSON.parse(text) } catch { res.payload = text } }
  return res
}

/** 走真实注册的路由处理器；ctx 不带 connection → 命中 isOriginSafe 退化路径 */
async function statusWith(headers, extra) {
  const { ctx, state } = makeCtx(undefined)
  plugin.apply(ctx)
  const route = state.routes.get(ROUTE)
  assert.ok(route, `route ${ROUTE} must be registered`)
  const res = fakeRes()
  await route.handler(fakeReq(headers, extra), res)
  return res.status
}

// ================= 允许：同源与回环别名 =================
const ALLOWED = [
  ['同源 GET 不带 Origin（浏览器同源 GET 本就不发）', { host: '127.0.0.1:43120' }],
  ['Host 与 Origin 逐字同源', { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' }],
  ['回环跨端口（answerer 可能在另一个端口）', { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:3080' }],
  ['回环别名 localhost → 127.0.0.1', { host: '127.0.0.1:43120', origin: 'http://localhost:3080' }],
  ['回环别名 [::1]', { host: '127.0.0.1:43120', origin: 'http://[::1]:3080' }],
  ['LAN 访问：Host 与 Origin 同源', { host: '192.168.1.5:43120', origin: 'http://192.168.1.5:43120' }],
  ['反代未声明 scheme 时不比 scheme（信息不足则放宽）', { host: '127.0.0.1:43120', origin: 'https://127.0.0.1:43120' }],
  ['反代声明 x-forwarded-proto=https 且 Origin 也是 https', { host: 'dsh.example.com', origin: 'https://dsh.example.com', 'x-forwarded-proto': 'https' }],
]
for (const [name, headers] of ALLOWED) {
  const code = await statusWith(headers)
  assert.strictEqual(code, 200, `must be allowed: ${name} (got ${code})`)
}
console.log(`  ✓ 允许 ${ALLOWED.length} 类同源/回环/反代来源`)

// ================= 拒绝：旧的「同名即放行」在这里全部被堵 =================
const REJECTED = [
  ['外来站点来源', { host: '127.0.0.1:43120', origin: 'http://evil.example' }],
  ['同名不同端口（旧实现不比端口）', { host: '192.168.1.5:43120', origin: 'http://192.168.1.5:9999' }],
  ['javascript: 伪来源（旧实现只解析 host）', { host: '127.0.0.1:43120', origin: 'javascript:alert(1)' }],
  ['data: 伪来源', { host: '127.0.0.1:43120', origin: 'data:text/html,<b>x</b>' }],
  ['沙箱 iframe 的 null 来源', { host: '127.0.0.1:43120', origin: 'null' }],
  ['scheme 不匹配（socket 为明文 http）', { host: '127.0.0.1:43120', origin: 'https://127.0.0.1:43120', 'x-forwarded-proto': 'http' }],
  ['Referer 指向外来站点', { host: '127.0.0.1:43120', referer: 'http://evil.example/attack.html' }],
]
for (const [name, headers] of REJECTED) {
  const code = await statusWith(headers, name.indexOf('socket 为明文') >= 0 ? { socket: { encrypted: false } } : undefined)
  assert.strictEqual(code, 403, `must be rejected: ${name} (got ${code})`)
}
console.log(`  ✓ 拒绝 ${REJECTED.length} 类跨源/伪来源/端口与 scheme 不匹配`)

// scheme 比对取自 socket.encrypted：TLS 请求上的明文 Origin 必须被拒；socket 未声明时不比
{
  const tlsPlaintext = await statusWith({ host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' }, { socket: { encrypted: true } })
  assert.strictEqual(tlsPlaintext, 403, 'a plaintext Origin on a TLS request must be rejected')
  const tlsTls = await statusWith({ host: '127.0.0.1:43120', origin: 'https://127.0.0.1:43120' }, { socket: { encrypted: true } })
  assert.strictEqual(tlsTls, 200, 'a TLS Origin on a TLS request is same-origin')
  const noSocket = await statusWith({ host: '127.0.0.1:43120', origin: 'https://127.0.0.1:43120' })
  assert.strictEqual(noSocket, 200, 'socket 无法判定为 TLS 时不做 scheme 比对')
  console.log('  ✓ scheme 比对取自 socket.encrypted（TLS 请求拒绝明文来源）')
}

// ================= 残余风险与真正的防线 =================
{
  // DNS rebinding：攻击者页面与本地服务字面上同源（Origin 与 Host 都是攻击域名），
  // 任何 Origin 比对都识别不出——这里显式写下来，避免以后把它当成「修好了」。
  const code = await statusWith({ host: 'evil.example', origin: 'http://evil.example' })
  assert.strictEqual(code, 200, 'documented residual: a literally same-origin rebinding page passes the origin check')

  // 真正的防线：connection.requestRejection（凭据围栏）。rebinding 页面拿不到 127.0.0.1 的 cookie。
  const { ctx, state } = makeCtx({ requestRejection: () => 401 })
  plugin.apply(ctx)
  const res = fakeRes()
  await state.routes.get(ROUTE).handler(fakeReq({ host: 'evil.example', origin: 'http://evil.example' }), res)
  assert.strictEqual(res.status, 401, 'the credential fence — not the origin check — is what stops rebinding')
  console.log('  ✓ 残余风险已写明，真正的防线是凭据围栏（rebinding 场景 401）')
}

console.log('All API origin fence tests passed successfully!')
