/**
 * 路径事实判定（确定性硬拒的基础设施）。
 *
 * 移植自 NanmiCoder/dsh-auto-mode `src/paths.ts`（MIT）。
 * 上游把「沙箱兜住常规写入、确定性规则只回答少数不变量」作为设计前提；
 * 本仓库吸收其中的路径规范化与破坏性目标熔断，用于把原先的关键词黑名单
 * 升级为基于路径事实的判定（见 index.mjs 的硬拒层）。
 *
 * 关键不变量：
 *   - normalizePath 不跟随符号链接，只做词法规范化（Windows 段尾点/空格剥离、
 *     盘符与 NT 命名空间折叠、win32 结果小写化）。
 *   - isWithin 只比较同风格（posix / win32）路径，风格不一致一律返回 false，
 *     避免把 `C:\x` 误判为位于 `/x` 之下。
 *   - hardDestructiveTargetReason 是单调熔断：文件系统根、Home、DSH_HOME、
 *     系统/凭据关键路径、Windows 设备命名空间一律给出理由，分类器无权推翻。
 *
 * 本文件必须与上游保持行为一致，改动前先确认上游是否已变更。
 */
import { homedir, tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

/** 判定所使用的根路径集合（全部为已规范化形态） */
// { workspace, home, dshHome, tempRoots }

/** 调用方可覆盖的根路径选项 */
// { workspaceRoot?, dshHome?, tempRoots?, home? }

/** 路径风格：posix 或 win32 */
// 'posix' | 'win32'

function explicitStyleOf(value) {
  const canonical = canonicalizeWindowsNamespace(value)
  if (/^[A-Za-z]:/.test(canonical) || canonical.startsWith('\\')) return 'win32'
  if (canonical.startsWith('/')) return 'posix'
  return undefined
}

/** 优先采用路径自身的显式语法；仅相对路径才参考 cwd */
function styleOf(value, cwd) {
  return explicitStyleOf(value)
    ?? (cwd === undefined ? undefined : explicitStyleOf(cwd))
    ?? (process.platform === 'win32' ? 'win32' : 'posix')
}

function pathApi(style) {
  return style === 'win32' ? win32 : posix
}

function normalizeWindowsSegments(path) {
  const root = win32.parse(path).root
  const tail = path.slice(root.length)
    .split('\\')
    .map(segment => segment.replace(/[ .]+$/g, ''))
    .join('\\')
  return tail === '' ? root : `${root}${tail}`
}

function windowsDeviceNamespaceReason(input) {
  const path = input.replaceAll('/', '\\').toLowerCase()
  if (path.startsWith('\\\\.\\')) return `Windows device namespace ${input}`
  if (path.startsWith('\\device\\') || path.startsWith('\\global??\\') || path.startsWith('\\dosdevices\\')) {
    return `Windows NT object namespace ${input}`
  }
  if (path.startsWith('\\\\?\\') && !/^\\\\\?\\(?:unc\\|[a-z]:\\)/.test(path)) {
    return `Windows extended device namespace ${input}`
  }
  if ((path.startsWith('\\??\\') || path.startsWith('\\\\??\\'))
    && !/^(?:\\\?\?\\|\\\\\?\?\\)(?:unc\\|[a-z]:\\)/.test(path)) {
    return `Windows NT device namespace ${input}`
  }
  return undefined
}

/** 在任何包含性判定之前折叠 Win32 / NT 命名空间别名 */
export function canonicalizeWindowsNamespace(input) {
  const lower = input.toLowerCase()
  if (lower.startsWith('\\\\?\\unc\\')) return `\\\\${input.slice(8)}`
  if (lower.startsWith('\\\\?\\')) return input.slice(4)
  if (lower.startsWith('\\\\??\\')) return input.slice(5)
  if (lower.startsWith('\\??\\')) return input.slice(4)
  return input
}

/** 在不做文件系统 IO 的前提下规范化 macOS 系统软链接写法 */
export function canonicalizePosixSystemAlias(path, platform = process.platform) {
  if (platform !== 'darwin') return path
  for (const alias of ['/tmp', '/var', '/etc']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

/** 规范化绝对路径或相对 cwd 的路径；不跟随符号链接 */
export function normalizePath(input, cwd, userHome = homedir()) {
  const canonicalInput = canonicalizeWindowsNamespace(input)
  const expanded = canonicalInput === '~'
    ? userHome
    : canonicalInput.startsWith('~/') || canonicalInput.startsWith('~\\')
      ? pathApi(styleOf(userHome)).join(userHome, canonicalInput.slice(2))
      : canonicalInput
  const style = styleOf(expanded, cwd)
  const api = pathApi(style)
  const absolute = api.isAbsolute(expanded) ? expanded : api.resolve(cwd, expanded)
  const normalized = api.normalize(absolute)
  return style === 'win32' ? normalizeWindowsSegments(normalized).toLowerCase() : canonicalizePosixSystemAlias(normalized)
}

/** 从当前工作区与进程环境解析根路径集合 */
export function resolveRoots(activeWorkspace, options = {}) {
  const home = normalizePath(options.home ?? homedir(), options.home ?? homedir(), options.home ?? homedir())
  const workspace = normalizePath(activeWorkspace ?? options.workspaceRoot ?? process.cwd(), process.cwd(), home)
  const environmentDshHome = process.env.DSH_HOME?.trim()
  const configuredDshHome = options.dshHome ?? (environmentDshHome === '' ? undefined : environmentDshHome)
  const dshHome = normalizePath(configuredDshHome ?? posix.join(home, '.dsh'), workspace, home)
  const tempRoots = (options.tempRoots ?? [tmpdir()]).map(root => normalizePath(root, workspace, home))
  return { workspace, home, dshHome, tempRoots }
}

/** 目标是否等于 root 或位于其下 */
export function isWithin(root, target) {
  const normalizedRoot = normalizePath(root, root)
  const normalizedTarget = normalizePath(target, root)
  const style = styleOf(normalizedRoot)
  if (styleOf(normalizedTarget) !== style) return false
  const api = pathApi(style)
  const relative = api.relative(normalizedRoot, normalizedTarget)
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative))
}

/** 目标是否为 POSIX / 盘符 / UNC 文件系统根 */
export function isFilesystemRoot(target) {
  const style = styleOf(target)
  const api = pathApi(style)
  const normalized = normalizePath(target, target)
  return api.parse(normalized).root === normalized
}

/** 目标是否属于操作系统或凭据关键目录树 */
export function isCriticalPath(target, roots) {
  const normalized = normalizePath(target, roots.workspace, roots.home)
  const windowsCritical = /^[a-z]:\\(?:windows|window~\d+|program files|program files \(x86\)|programdata|progra~\d+|boot)(?:\\|$)/i.test(normalized)
  const critical = styleOf(normalized) === 'win32'
    ? []
    : ['/etc', '/bin', '/sbin', '/usr', '/system', '/library', '/private/etc', '/boot']
  const credentialRoots = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config/gcloud']
    .map(path => normalizePath(path, roots.home, roots.home))
  return windowsCritical || [...critical, ...credentialRoots].some(root => isWithin(root, normalized))
}

/** 工作区内是否属于受保护元数据（而非普通项目内容） */
export function isProtectedProjectPath(target, roots) {
  const normalized = normalizePath(target, roots.workspace, roots.home)
  if (!isWithin(roots.workspace, normalized)) return false
  const style = styleOf(roots.workspace)
  const api = pathApi(style)
  const relative = api.relative(roots.workspace, normalized).replaceAll('\\', '/')
  const first = relative.split('/')[0]?.toLowerCase()
  if (first !== undefined && ['.git', '.vscode', '.idea', '.husky', '.dsh'].includes(first)) return true
  const base = api.basename(normalized).toLowerCase()
  return ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.mcp.json'].includes(base)
}

/** 确定性破坏性目标熔断；返回理由表示必须熔断 */
export function hardDestructiveTargetReason(target, roots) {
  const namespaceReason = windowsDeviceNamespaceReason(target)
  if (namespaceReason !== undefined) return namespaceReason
  const canonicalTarget = canonicalizeWindowsNamespace(target)
  if (/^[A-Za-z]:(?![\\/])/.test(canonicalTarget)) return `ambiguous Windows drive-relative path ${canonicalTarget}`
  const normalized = normalizePath(target, roots.workspace, roots.home)
  if (isFilesystemRoot(normalized)) return `filesystem root ${normalized}`
  if (styleOf(normalized) === 'win32') {
    const hasReservedDevice = normalized.split(/[\\/]/).some((segment) => {
      const base = segment.replace(/[ .]+$/g, '').split('.')[0]
      return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base ?? '')
    })
    if (hasReservedDevice) return `Windows reserved device path ${normalized}`
  }
  if (normalized === roots.home) return `user home root ${normalized}`
  if (isWithin(roots.dshHome, normalized)) return `DSH_HOME path ${normalized}`
  if (isCriticalPath(normalized, roots)) return `system or credential-critical path ${normalized}`
  return undefined
}

/** 目标是否属于可观测的会话产物区域（工作区或临时根） */
export function isArtifactArea(target, roots) {
  const normalized = normalizePath(target, roots.workspace, roots.home)
  return isWithin(roots.workspace, normalized) || roots.tempRoots.some(root => isWithin(root, normalized))
}

// ---- 命令文本里的绝对路径（确定性提取，不依赖模型措辞） ----

/**
 * 命令文本中「绝对路径字面量」的匹配式。
 *
 * 为什么需要它（2026-10-04 取证，见 _port-analysis/p01-digest6.md D 段）：
 * 原先只有 extractFiles() 一条宽松正则，它把 `IamNewHands/dsh-approval-gate`、`origin/main`、
 * `.git/objects` 这类**相对片段**也当成目标，而 `cd D:\GitHub_Clone\x; git push ...` 里的
 * 绝对路径反而没有进入事件记录 —— 628 条带命令的真实事件里 458 条（73%）记录不到任何
 * 绝对路径，于是「这次操作动的是工作区内还是工作区外」无法从审计记录回答。
 *
 * 只认四种绝对形态（前导边界字符不进入捕获组）：
 *   - 盘符：`C:\...` / `C:/...`
 *   - UNC：`\\server\share\...`
 *   - POSIX 根：`/...`（`//` 排除，避免把 `https://host/path` 的路径段当成绝对路径）
 *   - 波浪号家目录：`~\...` / `~/...`
 * 相对片段（`origin/main`、`refs/heads/x`、`src/a.ts`）**故意不提取**：它们无法单独定域，
 * 混进目标列表只会制造「看起来在工作区内」的假象。
 */
const ABS_PATH_TOKEN_RE = /(?:^|[\s"'`=(\[{,;|&])((?:[a-zA-Z]:[\\/]|\\\\[^\s\\/]+\\[^\s\\/]+|~[\\/]|\/(?!\/))[^\s"'`<>|*?;]*)/g

/**
 * 引号内的整段内容。路径含空格时只有引号能界定边界：
 * `'C:\Program Files\Git\bin\bash.exe'` 靠裸文本正则只能拿到 `C:\Program`。
 */
const QUOTED_SPAN_RE = /(["'])([^"'\r\n]{2,400}?)\1/g

/** 绝对路径的字面开头（用于判断引号内整段是不是一条路径） */
const ABS_PATH_HEAD_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|~[\\/]|\/(?!\/))/

/** 相对路径向上穿越：`..\..\Users\x`、`../x`。有它就无法靠字面量定域 */
const TRAVERSAL_RE = /(?:^|[\s"'`=(\[{,;|&])\.\.[\\/]/

/** MSYS / Git-Bash 盘符写法：`/d/GitHub_Clone` → `D:/GitHub_Clone` */
const MSYS_DRIVE_RE = /^\/([a-zA-Z])(?=\/|$)/

/** 设备/伪文件：是内核接口，不是数据目标 */
const DEVICE_PATH_RE = /^\/(?:dev|proc|sys)(?:\/|$)/i

/** 系统程序安装根：是「程序在哪」，不是「这次动了什么数据」 */
const PROGRAM_PATH_RE = /^(?:\/(?:usr\/)?(?:local\/)?s?bin\/|\/opt\/homebrew\/bin\/|[a-z]:[\\/]windows[\\/](?:system32|syswow64)[\\/]|[a-z]:[\\/]program files(?: \(x86\))?[\\/])/i

/** 剥掉命令语法带来的尾部标点；`Program Files (x86)` 这类内部括号不受影响 */
function trimPathToken(raw) {
  let s = raw.replace(/[.,。，、；：]+$/, '')
  while (s.length > 1) {
    const last = s[s.length - 1]
    if (last !== ')' && last !== ']' && last !== '}') break
    const open = last === ')' ? '(' : last === ']' ? '[' : '{'
    const opens = s.split(open).length - 1
    const closes = s.split(last).length - 1
    if (closes <= opens) break
    s = s.slice(0, -1)
  }
  return s
}

/**
 * 从任意文本（命令、说明、参数）里提取绝对路径字面量。
 *
 * 返回项：`{ raw, path, kind }`
 *   - `raw`  原文形态（给人看，保留盘符大小写与斜杠风格）
 *   - `path` 规范化形态（用于包含性判定；win32 一律小写）
 *   - `kind` `data`（数据目标）/ `program`（系统程序位置）/ `device`（设备伪文件）
 *
 * 只做词法判断，不做文件系统 IO；同名路径按规范化结果去重，最多 24 条。
 * @param {string} text - 待提取文本
 * @returns {Array<{raw: string, path: string, kind: string}>}
 */
export function extractAbsolutePaths(text) {
  const s = String(text == null ? '' : text)
  if (!s) return []
  const out = []
  const seen = new Set()
  // 已被引号整段吃掉的字符区间：裸文本再扫一遍时不能把它的前半截当成另一条路径
  // （`"C:\Program Files (x86)\App\a.dll"` 曾被裸正则截成 `C:\Program`）
  const consumed = []
  const push = (candidate, start, end) => {
    if (out.length >= 24) return
    if (start !== undefined && consumed.some(([a, b]) => start >= a && start < b)) return
    const raw = trimPathToken(candidate)
    if (raw.length < 3 || !ABS_PATH_HEAD_RE.test(raw)) return
    const expanded = raw.replace(MSYS_DRIVE_RE, (_, drive) => `${drive.toUpperCase()}:`)
    let path
    try {
      path = normalizePath(expanded, undefined, homedir())
    } catch { return }
    if (!path || path.length < 3 || seen.has(path)) return
    seen.add(path)
    if (start !== undefined) consumed.push([start, end])
    const kind = DEVICE_PATH_RE.test(raw)
      ? 'device'
      : PROGRAM_PATH_RE.test(path) ? 'program' : 'data'
    out.push({ raw, path, kind })
  }
  // 引号内的整段优先：含空格的路径只有这样才能完整取到（`'C:\Program Files\...'`）
  for (const m of s.matchAll(QUOTED_SPAN_RE)) push(m[2], m.index + 1, m.index + m[0].length - 1)
  for (const m of s.matchAll(ABS_PATH_TOKEN_RE)) {
    const tokenStart = m.index + (m[0].length - m[1].length)
    push(m[1], tokenStart, m.index + m[0].length)
  }
  return out
}

/**
 * 文本里是否出现相对路径向上穿越（`..\x`、`../x`）。
 *
 * 有穿越时，字面量绝对路径不足以定域：`cd D:\ws\x; Get-Content ..\..\Users\me\.ssh\id_rsa`
 * 只提取到 `D:\ws\x`（工作区内），但真实目标在工作区外。调用方必须把这种调用降级为
 * 「定域未知」，不能报成「工作区内」。
 * @param {string} text - 待检查文本
 * @returns {boolean}
 */
export function hasPathTraversal(text) {
  return TRAVERSAL_RE.test(String(text == null ? '' : text))
}

/**
 * 把绝对路径目标按「工作区内 / 工作区外」定域。
 *
 * 语义刻意是**保守**的：只统计 `kind === 'data'` 的绝对路径。
 *   - 一个 data 目标都没有 → `unknown`（不是 inside！相对片段与变量拼出的路径都算未知）
 *   - 全部在 workspace 之下 → `inside`
 *   - 有 workspace 之外的 → `outside`；内外都有 → `mixed`
 * 调用方据此决定是否放行时，`unknown` 必须与 `outside` 同等对待（fail-closed）。
 *
 * @param {Array<string|{path?: string, kind?: string}>} paths - extractAbsolutePaths() 的结果或裸路径串
 * @param {{workspace: string, home: string}} roots - resolveRoots() 的产物
 * @returns {{scope: 'inside'|'outside'|'mixed'|'unknown', inside: string[], outside: string[]}}
 */
export function classifyPathScope(paths, roots) {
  const list = Array.isArray(paths) ? paths : []
  const inside = []
  const outside = []
  const seen = new Set()
  for (const item of list) {
    if (!item) continue
    const rawPath = typeof item === 'string' ? item : item.path
    const kind = typeof item === 'string' ? 'data' : (item.kind || 'data')
    if (!rawPath || kind !== 'data') continue
    let target
    try {
      target = normalizePath(rawPath, roots.workspace, roots.home)
    } catch { continue }
    if (!target || seen.has(target)) continue
    seen.add(target)
    if (isWithin(roots.workspace, target)) inside.push(target)
    else outside.push(target)
  }
  const scope = outside.length > 0
    ? (inside.length > 0 ? 'mixed' : 'outside')
    : (inside.length > 0 ? 'inside' : 'unknown')
  return { scope, inside, outside }
}

// ---- 凭据材料事实判定（硬拒层：外发内容不得携带凭据） ----

const CREDENTIAL_MATERIAL_RE = /(?:BEGIN (?:[A-Z]+ )?PRIVATE KEY|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|gh[opusr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|\.ssh[\\/](?:id_|config)|\.credentials\.yaml)/i

/** 序列化后的工具参数是否含凭据材料（私钥 / 云密钥 / Bearer / .ssh 读取） */
export function containsCredentialMaterial(argumentsValue) {
  let serialized = ''
  try {
    serialized = JSON.stringify(argumentsValue)
  } catch {
    return false
  }
  return CREDENTIAL_MATERIAL_RE.test(serialized ?? '')
}

/** 外发 URL 是否携带凭据（userinfo 密码或 token 类查询参数） */
export function urlContainsCredential(value) {
  try {
    const url = new URL(value, 'https://relative.invalid')
    if (url.password) return true
    return [...url.searchParams].some(([key, val]) => /^(?:token|access_token|api[_-]?key|sig|signature|auth|authorization)$/i.test(key) && val.length >= 8)
  } catch { return true }
}
