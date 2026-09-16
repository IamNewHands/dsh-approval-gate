/**
 * dsh-approval-gate — 判定输入脱敏（sanitize）
 *
 * 移植自 NanmiCoder/dsh-auto-mode 的 `src/classifier.ts`（MIT License）。
 *
 * 作用：脱敏：密钥与大块正文在送入判定模型前被移除/截断。
 *   1. 文本级：私钥块、云厂商/AWS/GitHub/Slack 令牌、Bearer 头、`key=value` 形式的
 *      密钥，统一替换为 `[redacted-secret]`，并截断到 1000 字符；
 *   2. 参数级：按字段名识别密钥字段（→ `[redacted-secret-field]`）与大块正文字段
 *      （→ `[redacted-<key>:<len>-chars]`），递归深度上限 3、数组上限 25、对象条目上限 50。
 *
 * 约束：本文件必须与上游 `classifier.ts` 中
 *   `sanitizeClassifierText` / `sanitizeClassifierArguments`
 * 及其私有依赖 `isBulkContentKey` / `CONTENT_KEY_TERMS` / `ALWAYS_REDACTED_TEXT_KEYS` / `SECRET_KEYS`
 * 保持行为完全一致；改动前请先核对上游，不要引入额外依赖或额外导出。
 */

const CONTENT_KEY_TERMS = new Set(['body', 'content', 'data', 'diff', 'input', 'patch', 'payload', 'str', 'string', 'text'])
const ALWAYS_REDACTED_TEXT_KEYS = new Set(['description', 'justification'])
const SECRET_KEYS = /(?:api|auth|access|secret|private|credential|password|token|cookie|authorization).*?(?:key|value|token)?$/i

/** Recognize body-like fields across snake_case, kebab-case, and camelCase schemas. */
function isBulkContentKey(key) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const normalized = words.join('_')
  const last = words.at(-1)
  return ALWAYS_REDACTED_TEXT_KEYS.has(normalized)
    || (last !== undefined && CONTENT_KEY_TERMS.has(last))
}

/** Redact likely secrets and bound one classifier-visible text value. */
export function sanitizeClassifierText(value) {
  return value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, '[redacted-secret]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-secret]')
    .replace(/\bgh[opusr]_[A-Za-z0-9_]{8,}\b/g, '[redacted-secret]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted-secret]')
    .replace(/((?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted-secret]')
    .slice(0, 1_000)
}

/** Remove bulk content and likely secrets before crossing the classifier network boundary. */
export function sanitizeClassifierArguments(value, depth = 0) {
  if (depth > 3) return '[truncated-depth]'
  if (typeof value === 'string') return sanitizeClassifierText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitizeClassifierArguments(item, depth + 1))
  if (typeof value !== 'object') return `[${typeof value}]`
  const output = {}
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (SECRET_KEYS.test(key)) {
      output[key] = '[redacted-secret-field]'
    } else if (isBulkContentKey(key) && typeof entry === 'string') {
      output[key] = `[redacted-${key}:${entry.length}-chars]`
    } else {
      output[key] = sanitizeClassifierArguments(entry, depth + 1)
    }
  }
  return output
}
