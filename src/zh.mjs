/**
 * 审批说明中文化 + 结构化事实（纯函数，无 IO）。
 *
 * 事实来源：工具名 / 请求的沙箱模式 / 真实命令 / 真实目标路径（均由 host 侧解析），
 * 模型的 justification 只作为附注追加。命令与路径一律原样保留，不翻译、不改写。
 *
 * 两条出口：
 *   - describeFacts()：结构化事实（操作类型 / 路径 / 影响范围 / 命令 / 原文），
 *     供审批记录表格渲染（事件里存 facts 字段），也是文案生成的唯一数据源。
 *   - buildChineseReason()：宿主审批卡上那一段**纯文本**（宿主不渲染 HTML），
 *     按字段分行，能扫读；不再写成一大段「沙箱提权到…做什么…」的散文。
 */

/** 中日韩字符：出现即视为「说明已经是中文」，不再改写。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 文本是否含中日韩字符。
 * @param {unknown} text - 待检测文本。
 * @returns {boolean} 含中日韩字符时为 true。
 */
export function hasCJK(text) {
  return CJK_RE.test(text == null ? '' : String(text))
}

/** 缺失事实的占位文案：宁可写「未提供」，也不留空让人猜授权范围。 */
const NOT_PROVIDED = 'host未提供'

/**
 * 带命令语义的工具：只有这些工具缺命令时才写「命令：host未提供」。
 * write / edit 这类工具根本没有命令字段，硬写一行「host未提供」只是噪音。
 */
const COMMAND_TOOLS = new Set([
  'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh', 'exec', 'run', 'shell',
  'terminal', 'python', 'python3', 'node', 'deno', 'bun', 'curl', 'wget', 'ssh', 'scp'
])

function isCommandTool(toolName) {
  const name = String(toolName || '').trim().toLowerCase()
  return COMMAND_TOOLS.has(name) || /(?:^|[-_])(?:bash|sh|shell|exec|run|cmd|terminal)$/.test(name)
}

// ---- 操作类型：工具名 + 命令关键词共同决定 ----

/** 工具名 → 操作类型键。 */
const TOOL_ACTIONS = {
  write: 'write', write_file: 'write', create_file: 'write', create: 'write', new_file: 'write',
  edit: 'edit', edit_file: 'edit', str_replace_editor: 'edit', 'str-replace-editor': 'edit',
  replace: 'edit', patch: 'edit', apply_patch: 'edit',
  read: 'read', read_file: 'read', cat: 'read', view: 'read',
  glob: 'search', grep: 'search', search: 'search', ls: 'search', list: 'search'
}

/** 操作类型键 → 中文标签。 */
const ACTION_LABELS = {
  delete: '删除',
  write: '新增/写入',
  edit: '修改',
  remote: '推送/发布',
  exec: '执行命令',
  read: '读取',
  search: '检索',
  other: '调用'
}

/** 不可逆删除/破坏类命令：命中即把操作类型标成「删除」（决定审批人的第一眼风险判断）。 */
const DELETE_RE = /(?:^|[\s;&|()])(?:rm|rmdir|del|erase|remove-item|remove-itemproperty)\b|\b(?:format|mkfs(?:\.[a-z0-9]+)?|shutdown|reboot)\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|drop\s+(?:table|database)|truncate\s+table/i

/** 对外写入/发布类命令：影响面在远端，单独标成「推送/发布」。 */
const REMOTE_RE = /(?:^|[\s;&|()])(?:scp|rsync|ssh|curl|wget|invoke-webrequest|invoke-restmethod)\b|\bgit\b[^;&|()]*\bpush\b|\bgh\b[^;&|()]*\brelease\b|\b(?:npm|pnpm|yarn)\b[^;&|()]*\bpublish\b/i

function actionKeyFor(toolName, command, commandTool) {
  const cmd = String(command == null ? '' : command)
  if (cmd) {
    if (DELETE_RE.test(cmd)) return 'delete'
    if (REMOTE_RE.test(cmd)) return 'remote'
  }
  if (commandTool) return 'exec'
  const key = String(toolName || '').trim().toLowerCase()
  if (TOOL_ACTIONS[key]) return TOOL_ACTIONS[key]
  // 带命名空间的变体（mcp__fs.write_file / fs:write）取尾段再判
  const tail = key.split(/[./:]/).pop()
  if (tail && TOOL_ACTIONS[tail]) return TOOL_ACTIONS[tail]
  if (/(?:^|[-_])(?:write|create)$/.test(key)) return 'write'
  if (/(?:^|[-_])(?:edit|replace|patch)$/.test(key)) return 'edit'
  if (/(?:^|[-_])(?:read|cat|view)$/.test(key)) return 'read'
  return 'other'
}

// ---- 影响范围：沙箱模式 → 一句后果 ----

function scopeFor(mode, cwd) {
  const m = String(mode || '').trim()
  if (m === 'read-only') return { scopeShort: '只读', scopeDetail: '不会修改任何文件' }
  if (m === 'workspace-write') {
    const detail = cwd
      ? `仅工作区（${cwd}）内可写，工作区外仍被拒绝`
      : '仅工作区内可写，工作区外仍被拒绝'
    return { scopeShort: '工作区', scopeDetail: detail }
  }
  if (m === 'danger-full-access') {
    return { scopeShort: '整机', scopeDetail: '工作区外任意路径可读写，含系统位置；改动不可自动回滚' }
  }
  if (m) return { scopeShort: m, scopeDetail: `未识别的沙箱模式：${m}` }
  return { scopeShort: '未提权', scopeDetail: '沙箱模式不变；本次审批只放行这一次调用' }
}

/**
 * 目标定域 → 一句人话。
 *
 * 与 scopeFor()（沙箱模式的影响范围）是两个不同的轴：这里回答「这次碰的是哪些位置」。
 * `unknown` 必须显式说出来，不能留空 —— 相对片段、变量拼出的路径、`..` 穿越都落在这里，
 * 留空会被读成「没问题」。
 */
function targetScopeFor(scope, traversal) {
  const base = {
    inside: '工作区内',
    outside: '工作区外',
    mixed: '跨工作区内外',
    unknown: '无法定域（没有绝对路径）'
  }[String(scope || '')]
  if (!base) return ''
  return traversal && String(scope) !== 'outside' ? `${base} · 含 .. 穿越` : base
}

/** 截断过长文本，保留可读性。 */
function clip(text, max) {
  const s = String(text == null ? '' : text).trim()
  const limit = max || 400
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/**
 * 结构化审批事实：审批记录表格与文案生成共用这一份数据。
 *
 * @param {object} input - 审批事实。
 * @param {string} [input.toolName] - 工具名（pwsh / write / edit …）。
 * @param {string} [input.mode] - 解析出的目标沙箱模式，非提权请求时为空。
 * @param {string} [input.justification] - 模型给出的原始说明（可能英文）。
 * @param {string} [input.command] - 本次调用真实命令文本。
 * @param {string[]} [input.files] - 本次调用的写目标（供改动前快照，可能是相对路径）。
 * @param {string[]} [input.targets] - 本次调用指向的绝对路径（含只读目标，命令类工具也能提）。
 * @param {string} [input.targetScope] - 目标定域：inside / outside / mixed / unknown。
 * @param {boolean} [input.targetTraversal] - 命令里出现 `..` 穿越。
 * @param {string} [input.cwd] - 会话工作区。
 * @param {string} [input.commandSource] - 命令来源：'lastSameTool' 时标注「回溯最近同名调用」。
 * @returns {object} 事实对象（字段全部为可直接展示的字符串/数组）。
 */
export function describeFacts(input) {
  const o = input || {}
  const toolName = String(o.toolName || 'unknown').trim() || 'unknown'
  const command = clip(String(o.command == null ? '' : o.command).trim(), 300)
  const commandTool = isCommandTool(toolName)
  const actionKey = actionKeyFor(toolName, command, commandTool)
  const mode = String(o.mode || '').trim()
  // 操作路径 = 绝对路径目标在前（可定域的事实），写目标在后（可能是相对路径）
  const files = (Array.isArray(o.files) ? o.files : []).filter(Boolean).map(String)
  const targets = (Array.isArray(o.targets) ? o.targets : []).filter(Boolean).map(String)
  const merged = []
  for (const p of [...targets, ...files]) if (!merged.includes(p)) merged.push(p)
  const shown = merged.slice(0, 5).join('、')
  const pathText = merged.length > 0
    ? shown + (merged.length > 5 ? ` 等 ${merged.length} 处` : '')
    : NOT_PROVIDED
  // 命令来自「回溯最近同名调用」时标注来源，避免被当成这次调用的确切参数
  const commandLabel = o.commandSource === 'lastSameTool' ? '回溯最近同名调用' : ''
  const commandText = command
    ? `命令${commandLabel ? `（${commandLabel}）` : ''}：${command}`
    : (commandTool ? `命令：${NOT_PROVIDED}` : '')
  const scope = scopeFor(mode, o.cwd)
  const targetScope = String(o.targetScope || '').trim()
  const targetScopeText = targetScopeFor(targetScope, o.targetTraversal === true)
  return {
    tool: toolName,
    actionKey,
    action: ACTION_LABELS[actionKey] || ACTION_LABELS.other,
    mode,
    scopeShort: scope.scopeShort,
    scopeDetail: scope.scopeDetail,
    paths: merged,
    pathText,
    pathsMissing: merged.length === 0,
    targetScope,
    targetScopeText,
    targetTraversal: o.targetTraversal === true,
    command,
    commandLabel,
    commandText,
    commandTool,
    reason: clip(o.justification, 400)
  }
}

/**
 * 事件落盘用的精简事实：只保留白名单字段并逐项截断，避免 events.jsonl 无界膨胀。
 * @param {object} facts - describeFacts() 的产物。
 * @returns {object|null} 精简后的事实，或 null（无可用字段）。
 */
export function compactFacts(facts) {
  if (!facts || typeof facts !== 'object') return null
  const str = (v, max) => {
    const s = String(v == null ? '' : v).trim()
    return s ? s.slice(0, max) : ''
  }
  const out = {}
  const tool = str(facts.tool, 60)
  if (tool) out.tool = tool
  const action = str(facts.action, 24)
  if (action) out.action = action
  const actionKey = str(facts.actionKey, 16)
  if (actionKey) out.actionKey = actionKey
  const mode = str(facts.mode, 40)
  if (mode) out.mode = mode
  const scopeShort = str(facts.scopeShort, 24)
  if (scopeShort) out.scopeShort = scopeShort
  const scopeDetail = str(facts.scopeDetail, 160)
  if (scopeDetail) out.scopeDetail = scopeDetail
  if (Array.isArray(facts.paths)) {
    const paths = facts.paths.map((p) => str(p, 260)).filter(Boolean).slice(0, 8)
    if (paths.length > 0) out.paths = paths
  }
  if (facts.pathsMissing) out.pathsMissing = true
  const targetScope = str(facts.targetScope, 16)
  if (targetScope) out.targetScope = targetScope
  const targetScopeText = str(facts.targetScopeText, 40)
  if (targetScopeText) out.targetScopeText = targetScopeText
  if (facts.targetTraversal === true) out.targetTraversal = true
  const command = str(facts.command, 300)
  if (command) out.command = command
  const commandLabel = str(facts.commandLabel, 40)
  if (commandLabel) out.commandLabel = commandLabel
  const reason = str(facts.reason, 400)
  if (reason) out.reason = reason
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 构造宿主审批卡上的中文说明（纯文本，按字段分行）。
 *
 * 返回 null 表示无需改写（原文已是中文且不含宿主英文前缀）；
 * 否则返回给人看的说明，形如：
 *   操作：删除
 *   路径：C:\temp\a.txt
 *   影响：整机（工作区外任意路径可读写，含系统位置；改动不可自动回滚）
 *   命令：Remove-Item C:\temp\a.txt
 *   原因：清理临时文件
 *
 * @param {object} input - 同 describeFacts()。
 * @returns {string|null} 中文说明，或 null（无需改写）。
 */
export function buildChineseReason(input) {
  const o = input || {}
  const f = describeFacts(o)
  const mode = String(o.mode || '').trim()
  // 原文已是中文、且没有提权事实可补 → 不改写（避免替模型改措辞）
  if (hasCJK(f.reason) && !mode) return null
  const lines = [`操作：${f.action}`, `路径：${f.pathText}`]
  if (f.targetScopeText) lines.push(`目标：${f.targetScopeText}`)
  if (mode) lines.push(`影响：${f.scopeShort}（${f.scopeDetail}）`)
  if (f.commandText) lines.push(f.commandText)
  if (f.reason) lines.push(`原因：${f.reason}`)
  return lines.join('\n')
}
