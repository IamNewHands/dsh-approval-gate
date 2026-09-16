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
