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
 * @returns {string|null} 中文说明，或 null（无需改写）。
 */
export function buildChineseReason(input) {
  const o = input || {}
  const raw = clip(o.justification, 400)
  const mode = String(o.mode || '').trim()
  const cmd = o.command == null ? '' : String(o.command).trim()
  const files = (Array.isArray(o.files) ? o.files : []).filter(Boolean).map(String)
  const zhOk = hasCJK(raw)

  // 原文已是中文：只在需要去掉宿主英文前缀时改写
  if (zhOk) return mode ? `沙箱提权到 ${mode}：${raw}` : null

  const lines = []
  if (mode) {
    lines.push(`沙箱提权到 ${mode}：${effectText(mode, o.cwd)}`)
  } else {
    lines.push(`工具 ${String(o.toolName || 'unknown')} 的本次调用超出自动放行范围，需要人工判断。`)
  }
  const what = []
  if (cmd) what.push(`命令：${clip(cmd, 300)}`)
  if (files.length > 0) {
    const shown = files.slice(0, 5).join('、')
    what.push(`目标路径：${shown}${files.length > 5 ? ` 等 ${files.length} 处` : ''}`)
  }
  if (what.length > 0) lines.push(`做什么：${what.join('；')}`)
  if (raw) lines.push(`模型说明原文（未翻译）：${raw}`)
  return lines.join('\n')
}
