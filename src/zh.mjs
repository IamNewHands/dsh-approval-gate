/**
 * 审批说明中文化（纯函数，无 IO）。
 *
 * 事实来源：工具名 / 请求的沙箱模式 / 真实命令 / 真实目标路径（均由 host 侧解析），
 * 模型的 justification 只作为附注追加。命令与路径一律原样保留，不翻译、不改写。
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

/** 沙箱模式 → 后果说明（繁体/未知模式回退到原文模式名）。 */
const MODE_EFFECT = {
  'read-only': '只读：不会修改任何文件。',
  'workspace-write': '可修改工作区内的文件，工作区之外的路径仍会被拒绝。',
  'danger-full-access': '可读写工作区之外的任意路径（含系统位置），改动不再受沙箱限制，也无法自动回滚。'
}

function effectText(mode, cwd) {
  const known = MODE_EFFECT[mode]
  if (!known) return `请求的沙箱模式：${mode || '(未标明)'}。`
  if (mode === 'workspace-write' && cwd) return `可修改工作区（${cwd}）内的文件，工作区之外的路径仍会被拒绝。`
  return known
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

/**
 * 「做什么」行：目标路径永远显式出现；命令在有命令语义或确有命令时出现。
 * 缺失时写明 host 未提供；danger-full-access 额外说明它不限定路径，避免被误读成「只授权这条路径」。
 * @param {object} o - { mode, command, files, commandLabel, toolName }
 * @returns {string[]} 形如 ['命令：…', '目标路径：…']，至少一行
 */
function whatLines(o) {
  const lines = []
  const cmd = String(o.command == null ? '' : o.command).trim()
  const cmdLabel = o.commandLabel ? `命令（${o.commandLabel}）` : '命令'
  // 命令行为空且工具没有命令语义（write/edit 等）→ 整行略去，只留目标路径
  if (cmd) lines.push(`${cmdLabel}：${clip(cmd, 300)}`)
  else if (isCommandTool(o.toolName)) lines.push(`命令：${NOT_PROVIDED}`)
  const files = (Array.isArray(o.files) ? o.files : []).filter(Boolean).map(String)
  if (files.length > 0) {
    const shown = files.slice(0, 5).join('、')
    lines.push(`目标路径：${shown}${files.length > 5 ? ` 等 ${files.length} 处` : ''}`)
  } else if (o.mode === 'danger-full-access') {
    lines.push(`目标路径：${NOT_PROVIDED}（danger-full-access 不限定路径，本次授权覆盖整机，而非某一条路径）`)
  } else {
    lines.push(`目标路径：${NOT_PROVIDED}`)
  }
  return lines
}

/** 截断过长文本，保留可读性。 */
function clip(text, max) {
  const s = String(text == null ? '' : text).trim()
  const limit = max || 400
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/**
 * 构造中文审批说明。
 *
 * 返回 null 表示无需改写（原文已是中文且不含宿主英文前缀）；
 * 否则返回给人看的中文说明：做什么 / 什么后果 / 模型原文附注。
 *
 * @param {object} input - 审批事实。
 * @param {string} [input.toolName] - 工具名（pwsh / write / edit …）。
 * @param {string} [input.mode] - 解析出的目标沙箱模式，非提权请求时为空。
 * @param {string} [input.justification] - 模型给出的原始说明（可能英文）。
 * @param {string} [input.command] - 本次调用真实命令文本。
 * @param {string[]} [input.files] - 本次调用真实目标路径。
 * @param {string} [input.cwd] - 会话工作区。
 * @param {string} [input.commandSource] - 命令来源：'lastSameTool' 时标注「回溯最近同名调用」。
 * @returns {string|null} 中文说明，或 null（无需改写）。
 */
export function buildChineseReason(input) {
  const o = input || {}
  const raw = clip(o.justification, 400)
  const mode = String(o.mode || '').trim()
  const cmd = o.command == null ? '' : String(o.command).trim()
  const files = (Array.isArray(o.files) ? o.files : []).filter(Boolean).map(String)
  const zhOk = hasCJK(raw)
  // 命令来自「回溯最近同名调用」时标注来源，避免被当成这次调用的确切参数
  const commandLabel = o.commandSource === 'lastSameTool' ? '回溯最近同名调用' : ''

  // 原文已是中文：去掉宿主英文前缀，并把「做什么」行同样补上（命令/目标路径缺失时写明 host 未提供）
  if (zhOk) {
    if (!mode) return null
    return [`沙箱提权到 ${mode}：${raw}`, `做什么：${whatLines({ mode, command: cmd, files, commandLabel, toolName: o.toolName }).join('；')}`].join('\n')
  }

  const lines = []
  if (mode) {
    lines.push(`沙箱提权到 ${mode}：${effectText(mode, o.cwd)}`)
    lines.push(`做什么：${whatLines({ mode, command: cmd, files, commandLabel, toolName: o.toolName }).join('；')}`)
  } else {
    lines.push(`工具 ${String(o.toolName || 'unknown')} 的本次调用超出自动放行范围，需要人工判断。`)
    const what = []
    if (cmd) what.push(`命令：${clip(cmd, 300)}`)
    if (files.length > 0) {
      const shown = files.slice(0, 5).join('、')
      what.push(`目标路径：${shown}${files.length > 5 ? ` 等 ${files.length} 处` : ''}`)
    }
    if (what.length > 0) lines.push(`做什么：${what.join('；')}`)
  }
  if (raw) lines.push(`模型说明原文（未翻译）：${raw}`)
  return lines.join('\n')
}
