/**
 * 客户端 bundle 渲染冒烟测试。
 *
 * 为什么需要它：client.js 是浏览器 bundle，`node --check` 只证明语法合法，
 * 证明不了组件真的能渲染——新加的「拒绝提示条常驻」「追认按钮」逻辑一旦写错
 * （hooks 顺序、闭包引用、事件处理），只有在 GUI 里点到那一步才会炸。
 *
 * 做法：用最小可用的 React hooks 垫片 + DOM/fetch 桩，把 bundle 注册的
 * conversation.input.dock / conversation.view 组件**真正渲染一次**，断言：
 *   1. 静默拒绝（judge-deny, neutral）渲染常驻提示条，带「重新审批通过」与「查看审批记录」
 *   2. 硬拒档常驻提示条，但**不**给追认按钮（白名单盖不过硬拒层）
 *   3. 审批视图只为可追认的行显示「重新审批通过」
 *   3c. 追认后的记录文案翻转为「已追认放行」、改用中性色，且不再计入待处理
 *   3d. 追认过的拒绝刷新后不再弹常驻提示条
 *   4. 打开审批 tab 会把拒绝标记为已读；已读记录刷新后不再弹提示条
 *
 * 垫片只实现 bundle 实际用到的 createElement / useState / useRef / useEffect。
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CLIENT_SRC = readFileSync(join(REPO_ROOT, 'client.js'), 'utf8')

console.log('Testing client bundle render (smoke)...')

// ================= 最小 React 垫片 =================
/**
 * 每个组件函数各自持有一份 hooks 状态（按组件身份键控）——bundle 注册的是
 * 一层包装组件，包装与内层真实组件共享一个数组会互相踩游标。
 *
 * effect 语义按 React 建模：**只在依赖变化时**先跑上一次的 cleanup 再重跑；
 * 依赖不变则完全不动（否则组件里 `alive` 之类的守卫会在重渲染时被误清，
 * 异步回调永远等不到结果——这正是本测试第一版踩到的坑）。
 */
function createReact() {
  const states = new Map()
  let current = null

  const slotFor = (Component) => {
    if (!states.has(Component)) {
      states.set(Component, { hooks: [], effects: [], pending: [], cursor: 0, effectCursor: 0 })
    }
    return states.get(Component)
  }

  return {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props)
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const s = current
      const i = s.cursor++
      if (!(i in s.hooks)) s.hooks[i] = typeof initial === 'function' ? initial() : initial
      return [s.hooks[i], (v) => { s.hooks[i] = typeof v === 'function' ? v(s.hooks[i]) : v }]
    },
    useRef(initial) {
      const s = current
      const i = s.cursor++
      if (!(i in s.hooks)) s.hooks[i] = { current: initial }
      return s.hooks[i]
    },
    useEffect(fn, deps) {
      const s = current
      const i = s.effectCursor++
      s.pending.push({ index: i, fn, deps })
    },
    /** 渲染一个函数组件：重置游标 → 调用组件 → 按依赖变化执行 effect */
    render(Component, props) {
      const s = slotFor(Component)
      s.cursor = 0
      s.effectCursor = 0
      s.pending = []
      const prev = current
      current = s
      let tree
      try {
        tree = Component(props)
      } finally {
        current = prev
      }
      for (const { index, fn, deps } of s.pending) {
        const prevEffect = s.effects[index]
        const changed = !prevEffect || deps === undefined
          || deps.some((d, k) => d !== prevEffect.deps[k])
        if (!changed) continue
        if (prevEffect && typeof prevEffect.cleanup === 'function') prevEffect.cleanup()
        const cleanup = fn()
        s.effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      }
      return tree
    },
  }
}

// ================= DOM / fetch 桩 =================
function createEnv(events, opts) {
  const options = opts || {}
  const store = new Map()
  const listeners = {}
  const env = { fetchCalls: [], alerts: [] }
  const win = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, v) },
    },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn) },
    removeEventListener: (name, fn) => {
      listeners[name] = (listeners[name] || []).filter((f) => f !== fn)
    },
    dispatchEvent: (ev) => { for (const fn of listeners[ev.type] || []) fn(ev) },
    alert: (m) => { env.alerts.push(String(m)) },
    confirm: () => true,
    CustomEvent: class { constructor(type) { this.type = type } },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
  env.window = win
  env.document = {
    createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
    head: { appendChild() {} },
    querySelectorAll: () => [],
  }
  env.fetch = (url) => {
    const target = String(url)
    env.fetchCalls.push(target)
    if (target.indexOf('/api/auto-approve/reconsider') >= 0) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rule: { tool: 'edit' }, duplicate: false }) })
    }
    if (target.indexOf('/api/auto-approve/snapshots-stats') >= 0) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, count: 0, bytes: 0, ids: [], files: {} }) })
    }
    if (target.indexOf('/api/auto-approve/rules') >= 0) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          config: Object.assign({
            riskyThreshold: 3,
            judgeTimeoutMs: 20000,
            judgeFailureLimit: 1,
            judgeMaxTokens: 1024,
            hardCategories: options.hardCategories || [],
            allowRules: [],
            denyRules: [],
            denyKeywords: [],
            judgeModel: { provider: 'ai-gateway', model: 'sensenova/deepseek-v4-flash' },
          }, options.config || {}),
          learning: { stats: {}, history: {} },
          predefined: { denyKeywords: [], allowRules: [], hardCategories: [] },
          setup: { configured: true, patchPath: 'x' },
        }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ events, hardCategories: options.hardCategories }) })
  }
  return env
}

/** 在沙箱里装载 bundle，返回注册的槽位组件与 React 垫片 */
function boot(env) {
  let factory = null
  const React = createReact()
  const sandbox = {
    window: Object.assign({}, env.window, {
      __ModuleLoader__: { load: (spec) => { factory = spec.factory } },
    }),
    document: env.document,
    fetch: env.fetch,
    console,
    URL,
    CustomEvent: env.window.CustomEvent,
    setInterval: env.window.setInterval,
    clearInterval: env.window.clearInterval,
    setTimeout: env.window.setTimeout,
    clearTimeout: env.window.clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'client.js' })
  assert.ok(typeof factory === 'function', 'bundle must register a factory')

  // bundle 的 factory 自己创建 module 并 return module.exports
  const exported = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  const plugin = exported && exported.default
  assert.ok(plugin && typeof plugin.apply === 'function', 'bundle must export the plugin')

  const registrations = []
  plugin.apply({
    get: (key) => (key === 'slots' ? {
      inject: (name, cb) => { cb() },
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    } : undefined),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  })

  const component = (id) => {
    const hit = registrations.find((r) => r.options.id === id)
    assert.ok(hit, `slot ${id} must be registered`)
    return hit.Component
  }
  return { React, component, registrations }
}

/**
 * 渲染槽位组件并展开包装层：
 * bundle 注册的是 `(props) => createElement(RealComponent, { slotsProps: props })`，
 * 因此传入的是**扁平的**会话 props，展开一层后才拿到真实输出。
 */
function renderSlot(booted, Component, props) {
  let tree = booted.React.render(Component, props)
  let guard = 0
  while (tree && typeof tree.type === 'function' && guard++ < 5) {
    tree = booted.React.render(tree.type, tree.props)
  }
  return tree
}

/** 渲染两次：第一次触发 effect 的异步拉取，等微任务后再渲染取结果 */
async function renderSettled(booted, Component, props) {
  renderSlot(booted, Component, props)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  return renderSlot(booted, Component, props)
}

/** 递归收集元素树里的文本、class 与按钮 */
function inspect(node, out) {
  out = out || { text: '', classes: [], buttons: [] }
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.text += String(node) + ' '; return out }
  if (Array.isArray(node)) { for (const n of node) inspect(n, out); return out }
  const cls = node.props && node.props.className
  if (typeof cls === 'string' && cls) out.classes.push(cls)
  if (node.type === 'button') {
    out.buttons.push({
      text: String(node.props.children === undefined ? '' : node.props.children),
      title: node.props.title,
      disabled: node.props.disabled,
      onClick: node.props.onClick,
    })
  }
  if (node.props && node.props.children !== undefined) inspect(node.props.children, out)
  return out
}

// ================= 1. 静默拒绝 → 常驻提示条 + 追认按钮 =================
{
  const env = createEnv([{
    id: 7, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    tool: 'edit', ts: '2026-09-16T13:13:25.291Z', verdict: 'judge-deny',
    justification: '编辑 Merge.yaml', files: ['Merge.yaml'],
  }])
  const booted = boot(env)
  const Notice = booted.component('dsh-approval-gate.notice')

  const first = renderSlot(booted, Notice, { sessionId: 's1' })
  assert.strictEqual(first, null, 'nothing is shown before the first poll resolves')

  const tree = await renderSettled(booted, Notice, { sessionId: 's1' })
  assert.ok(tree, 'an unseen silent reject must keep a notice on screen')
  const info = inspect(tree)
  assert.ok(/已直接拒绝/.test(info.text), 'the notice reports the rejection')
  assert.ok(info.classes.some((c) => c.indexOf('ag-notice-card-reject') >= 0), 'reject styling is applied')
  assert.ok(/未读/.test(info.text), 'the notice explains it stays until seen')
  assert.ok(info.buttons.some((b) => b.text === '重新审批通过'), 'a neutral silent reject offers re-approval')
  assert.ok(info.buttons.some((b) => b.text === '查看审批记录'), 'a jump-to-tab action is offered')
  console.log('  ✓ 静默拒绝 → 常驻提示条 + 「重新审批通过」/「查看审批记录」')
}

// ================= 2. 硬拒档 → 常驻但**不**给追认按钮 =================
{
  const env = createEnv([{
    id: 8, kind: 'hard-reject', path: 'hard-deny', category: 'credential',
    tool: 'web_fetch', ts: '2026-09-16T13:14:00.000Z', verdict: 'hard-reject',
    justification: '外发凭据', files: [],
  }])
  const booted = boot(env)
  const Notice = booted.component('dsh-approval-gate.notice')
  const tree = await renderSettled(booted, Notice, { sessionId: 's2' })
  assert.ok(tree, 'a hard reject still surfaces on screen')
  const info = inspect(tree)
  assert.ok(/凭据外泄或系统路径销毁/.test(info.text), 'the hard-reject reason is shown')
  assert.ok(!info.buttons.some((b) => b.text === '重新审批通过'),
    'the hard-deny tier must not offer re-approval (a whitelist rule cannot override it)')
  console.log('  ✓ 硬拒档 → 常驻提示条，但不提供追认按钮')
}

// ================= 3. 审批视图：仅可追认的行有按钮 =================
{
  const env = createEnv([
    { id: 11, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral', tool: 'edit', ts: '2026-09-16T13:20:00.000Z', verdict: 'judge-deny', justification: '编辑配置', files: [] },
    { id: 12, kind: 'hard-reject', path: 'hard-deny', category: 'credential', tool: 'web_fetch', ts: '2026-09-16T13:21:00.000Z', verdict: 'hard-reject', justification: '外发凭据', files: [] },
    { id: 13, kind: 'judge-deny', path: 'classifier-deny', category: 'system', tool: 'edit', ts: '2026-09-16T13:22:00.000Z', verdict: 'judge-deny', justification: '系统路径', files: [] },
    { id: 14, kind: 'auto', tool: 'pwsh', ts: '2026-09-16T13:23:00.000Z', verdict: 'rule', justification: 'git status', files: [] },
  ])
  const booted = boot(env)
  const History = booted.component('dsh-approval-gate.history')
  const tree = await renderSettled(booted, History, { sessionId: 's3' })
  const info = inspect(tree)
  const reapprove = info.buttons.filter((b) => b.text === '重新审批通过')
  assert.strictEqual(reapprove.length, 1,
    'exactly one row (the neutral judge-deny) offers re-approval; got ' + reapprove.length)
  assert.ok(/待处理/.test(info.text), 'the view reports how many rejects are still pending')
  assert.ok(/已直接拒绝/.test(info.text), 'silent rejects are listed')
  console.log('  ✓ 审批视图：仅 neutral 的 judge-deny 有「重新审批通过」（硬拒/硬类别不给）')
}

// ================= 3b. 追认按钮的显隐跟随服务端下发的 hardCategories =================
{
  // hardCategories 可在设置页修改且参与多机同步，因此不能在前端硬编码：
  // 服务端把 'custom' 加进硬类别、同时把 'system' 移出，前端两个方向都要跟上。
  const env = createEnv([
    { id: 41, kind: 'judge-deny', path: 'classifier-deny', category: 'custom', tool: 'edit', ts: '2026-09-16T13:25:00.000Z', verdict: 'judge-deny', justification: '自定义硬类别', files: [] },
    { id: 42, kind: 'judge-deny', path: 'classifier-deny', category: 'system', tool: 'edit', ts: '2026-09-16T13:26:00.000Z', verdict: 'judge-deny', justification: '已被移出硬类别', files: [] },
  ], { hardCategories: ['deletion', 'credential', 'remote', 'bulk', 'custom'] })
  const booted = boot(env)
  const History = booted.component('dsh-approval-gate.history')
  const tree = await renderSettled(booted, History, { sessionId: 's6' })
  const info = inspect(tree)
  const reapprove = info.buttons.filter((b) => b.text === '重新审批通过')
  assert.strictEqual(reapprove.length, 1,
    'exactly the category the server removed from hardCategories offers re-approval; got ' + reapprove.length)
  console.log('  ✓ 追认按钮跟随服务端 hardCategories（自定义类别被拦、被移出的类别放开）')
}

// ================= 3c. 追认后的记录：文案翻转为「已放行」，且不再算待处理 =================
{
  // 追认**不改写**原事件（它仍是那次拒绝，审计事实保留），只加 reconsidered 标记。
  // 但用户已放行该操作 → 文案与配色必须从「被拒」翻转，否则用户看到红色「已直接拒绝」
  // 会以为追认没生效（真实踩坑：event 214/215，判定器不可用 → 追认后仍显示红色拒绝）。
  const env = createEnv([
    { id: 51, kind: 'judge-deny', path: 'judge-unavailable', category: 'neutral', tool: 'edit', ts: '2026-09-17T11:22:03.000Z', verdict: 'judge-deny', justification: '写 custom_phrase.dict.yaml', files: [], reconsidered: true },
    { id: 52, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral', tool: 'edit', ts: '2026-09-17T11:23:00.000Z', verdict: 'judge-deny', justification: '仍未追认', files: [] },
  ])
  const booted = boot(env)
  const History = booted.component('dsh-approval-gate.history')
  const tree = await renderSettled(booted, History, { sessionId: 's7' })
  const info = inspect(tree)
  assert.ok(/已追认放行 · 判定器不可用（曾直接拒绝）/.test(info.text),
    'a reconsidered record reads as approved-and-released, keeping the original reason in parentheses')
  assert.ok(!/已追认 · 已直接拒绝/.test(info.text),
    'the old "已追认 · 已直接拒绝" wording must be gone (it looked like it was still rejected)')
  assert.ok(/待处理 1/.test(info.text),
    'only the still-pending rejection counts; the reconsidered one is released (got: ' + info.text + ')')
  // 追认行用中性/完成色，未追认行仍是红色错误色
  assert.ok(info.classes.some((c) => c === 'ag-tag-warn'), 'the reconsidered row uses the done/amber tag')
  assert.ok(info.classes.some((c) => c === 'ag-tag-err'), 'the still-pending row keeps the red tag')
  console.log('  ✓ 追认后的记录 → 「已追认放行」文案 + 中性色，且不再计入待处理')
}

// ================= 3d. 追认过的拒绝不再弹常驻提示条 =================
{
  const env = createEnv([{
    id: 61, kind: 'judge-deny', path: 'judge-unavailable', category: 'neutral',
    tool: 'edit', ts: '2026-09-17T11:22:03.000Z', verdict: 'judge-deny',
    justification: '写 custom_phrase.dict.yaml', files: [], reconsidered: true,
  }])
  const booted = boot(env)
  const Notice = booted.component('dsh-approval-gate.notice')
  const tree = await renderSettled(booted, Notice, { sessionId: 's8' })
  assert.strictEqual(tree, null,
    'a reconsidered rejection is released, so it must not re-surface as a red notice after a reload')
  console.log('  ✓ 追认过的拒绝刷新后不再弹红色提示条')
}

// ================= 4. 打开审批 tab → 标记已读 =================
{
  const env = createEnv([{
    id: 21, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    tool: 'edit', ts: '2026-09-16T13:30:00.000Z', verdict: 'judge-deny', justification: '编辑配置', files: [],
  }])
  const booted = boot(env)
  const History = booted.component('dsh-approval-gate.history')
  await renderSettled(booted, History, { sessionId: 's4' })
  const seen = JSON.parse(env.window.localStorage.getItem('dsh-approval-gate.seenRejects') || '[]')
  assert.ok(seen.indexOf(21) >= 0, 'opening the approval tab marks rejects as seen')
  console.log('  ✓ 打开审批 tab → 拒绝标记已读（提示条据此收起）')
}

// ================= 5. 已读的拒绝不再弹提示条（刷新后不重复打扰） =================
{
  const env = createEnv([{
    id: 31, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    tool: 'edit', ts: '2026-09-16T13:40:00.000Z', verdict: 'judge-deny', justification: '编辑配置', files: [],
  }])
  env.window.localStorage.setItem('dsh-approval-gate.seenRejects', JSON.stringify([31]))
  const booted = boot(env)
  const Notice = booted.component('dsh-approval-gate.notice')
  const tree = await renderSettled(booted, Notice, { sessionId: 's5' })
  assert.strictEqual(tree, null, 'an already-seen reject must not re-surface after a reload')
  console.log('  ✓ 已读拒绝刷新后不再弹提示条')
}

// ================= 3e. 判定器不可用：文案区分「判定器挂了」与「操作有害」，并显示失败原因 =================
{
  // 判定器不可用不是"这个操作有害"。文案必须让用户一眼分清，否则会把网络故障误读成自己的操作被否。
  const env = createEnv([
    { id: 71, kind: 'judge-deny', path: 'judge-unavailable', category: 'neutral', tool: 'write', ts: '2026-09-18T12:43:35.000Z', verdict: 'judge-deny', justification: '并入词条', files: [], failureReason: '判定模型未产出正文（reasoning 812 字符，maxTokens=256）' },
    { id: 72, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral', tool: 'write', ts: '2026-09-18T12:44:00.000Z', verdict: 'judge-deny', justification: '判定为有害', files: [] },
  ])
  const booted = boot(env)
  const History = booted.component('dsh-approval-gate.history')
  const tree = await renderSettled(booted, History, { sessionId: 's9' })
  const info = inspect(tree)
  assert.ok(/判定器不可用（非操作本身有问题）/.test(info.text),
    'judge-unavailable reads as an infrastructure problem, not a harmful operation')
  assert.ok(/判定为有害或越权/.test(info.text), 'classifier-deny keeps its own wording')
  assert.ok(/判定模型未产出正文/.test(info.text),
    'the real failure reason is shown so the user can tell timeout from empty output')
  console.log('  ✓ 判定器不可用 vs 有害：文案区分，并显示真实失败原因')
}

// ================= 6. 设置页仍可渲染（回归） =================
{
  const env = createEnv([])
  const booted = boot(env)
  const Settings = booted.component('dsh-approval-gate.settings')
  const tree = await renderSettled(booted, Settings, {})
  assert.ok(tree, 'the settings section still renders')
  const info = inspect(tree)
  assert.ok(/判定器失败即转人工/.test(info.text), 'settings expose the judge failure limit')
  assert.ok(/判定输出上限/.test(info.text), 'settings expose the judge max tokens')
  console.log('  ✓ 设置页仍可渲染（含判定器失败上限 / 输出上限两个新配置项）')
}

// ================= 7. 审批说明中文化：zh 字段优先渲染 =================
{
  // 模型写的 justification 可能是英文（子代理/其他 provider 尤其常见）；host 侧会用结构化
  // 事实（目标沙箱模式 / 真实命令 / 真实目标路径）生成中文说明放进 zh 字段。
  // 提示条必须优先显示 zh，否则审批人又要读英文才能决定批不批。
  const EN = 'Same sandbox denial as before: msys bash cannot create its signal pipe.'
  const ZH = '沙箱提权到 danger-full-access：可读写工作区之外的任意路径（含系统位置），改动不再受沙箱限制，也无法自动回滚。\n模型说明原文（未翻译）：' + EN
  const env = createEnv([{
    id: 81, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral',
    tool: 'pwsh', mode: 'danger-full-access', ts: '2026-09-21T07:30:06.000Z',
    verdict: 'judge-deny', justification: EN, zh: ZH, files: [],
  }])
  const booted = boot(env)
  const Notice = booted.component('dsh-approval-gate.notice')
  const tree = await renderSettled(booted, Notice, { sessionId: 's10' })
  const info = inspect(tree)
  assert.ok(tree, 'a pending rejection must surface as a notice')
  assert.ok(/已直接拒绝/.test(info.text), 'the notice keeps its own label')
  assert.ok(info.text.indexOf('沙箱提权到 danger-full-access') >= 0,
    'the notice renders the Chinese zh text instead of leading with the English original')
  console.log('  ✓ 提示条：优先渲染 zh 中文说明')
}

// ================= 7b. 审批记录行：有 zh 用中文，无 zh 回退原文 =================
{
  const env = createEnv([
    { id: 82, kind: 'judge-deny', path: 'classifier-deny', category: 'neutral', tool: 'edit', ts: '2026-09-21T07:31:00.000Z', verdict: 'judge-deny', justification: '编辑 Merge.yaml', files: [] },
    { id: 83, kind: 'auto', tool: 'pwsh', ts: '2026-09-21T07:32:00.000Z', verdict: 'rule', justification: 'git status', files: [], zh: '沙箱提权到 workspace-write：可修改工作区内的文件，工作区之外的路径仍会被拒绝。\n做什么：命令：git status' },
  ])
  const booted = boot(env)
  const History = booted.component('dsh-approval-gate.history')
  const tree = await renderSettled(booted, History, { sessionId: 's11' })
  const info = inspect(tree)
  assert.ok(info.text.indexOf('沙箱提权到 workspace-write') >= 0,
    'a recorded event with zh renders the Chinese explanation')
  assert.ok(info.text.indexOf('编辑 Merge.yaml') >= 0,
    'a recorded event without zh still falls back to the original justification (old records must not go blank)')
  console.log('  ✓ 审批记录行：zh 优先，缺 zh 时回退 justification 原文')
}

console.log('All client render smoke tests passed successfully!')
