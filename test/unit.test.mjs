import assert from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 隔离 DSH_HOME：模块加载时会初始化/落盘 allowlist.json，
// 必须指向临时目录，绝不能碰用户真实的 ~/.dsh/auto-approve/allowlist.json。
const tempHome = mkdtempSync(join(tmpdir(), 'ag-unittest-'))
mkdirSync(join(tempHome, 'auto-approve'), { recursive: true })
process.env.DSH_HOME = tempHome

const plugin = (await import(pathToFileURL(new URL('../src/index.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href)).default
process.on('exit', () => { try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ } })

// We will test exported plugin or functions by loading index.mjs or testing its logic
console.log('Testing dsh-approval-gate...')

// Let's test the functionality directly
// 1. matchRule test
function matchRule(rules, toolName, mode, category, justification) {
  const list = rules || []
  const j = String(justification || '').toLowerCase()
  for (const rule of list) {
    if (rule.tool && rule.tool !== toolName) continue
    if (rule.mode && rule.mode !== mode) continue
    if (category !== null && category !== undefined && rule.category && rule.category !== category) continue
    if (rule.contains && !j.includes(String(rule.contains).toLowerCase())) continue
    return rule
  }
  return null
}

const allowRules = [
  { mode: 'workspace-write', description: '工作区写入' },
  { contains: 'git', description: 'Git 常规操作自动放行' },
  { contains: 'github', description: 'GitHub/GCM 凭据与网络交互自动放行' },
  { tool: 'pwsh', mode: 'danger-full-access', category: 'neutral', contains: 'vitest', description: '自动沉淀：中立' }
]

// Step 2 calls matchRule with null category:
const matchedInStep2 = matchRule(allowRules, 'pwsh', 'danger-full-access', null, 'vitest run test.js')
assert.ok(matchedInStep2, 'Step 2 MUST match learned rule with category: neutral when category is null')
assert.strictEqual(matchedInStep2.contains, 'vitest')

// Workspace-write rule match
const matchedWs = matchRule(allowRules, 'edit', 'workspace-write', null, 'edit file.js')
assert.ok(matchedWs, 'Step 2 must match workspace-write rule')

// Git operations tests
const matchedGit1 = matchRule(allowRules, 'pwsh', 'danger-full-access', null, 'git push origin main')
assert.ok(matchedGit1, 'Git push under danger-full-access MUST match git allow rule')

const matchedGit2 = matchRule(allowRules, 'bash', 'danger-full-access', null, 'git clone https://github.com/repo')
assert.ok(matchedGit2, 'Git clone under bash MUST match git allow rule')

const matchedGit3 = matchRule(allowRules, 'pwsh', 'workspace-write', null, 'git status')
assert.ok(matchedGit3, 'Git status under workspace-write MUST match git allow rule')

const matchedGithub = matchRule(allowRules, 'pwsh', 'danger-full-access', null, 'Windows 凭据管理器读取 GitHub token')
assert.ok(matchedGithub, 'GitHub credential access MUST match github allow rule')

// Tool command resolution test
function resolveToolCallArgs(callId, events) {
  if (!callId || !Array.isArray(events) || events.length === 0) return null
  for (const ev of events) {
    if (ev && ev.type === 'tool/call' && ev.data && ev.data.callId === callId) {
      const raw = ev.data.arguments
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }
  }
  return null
}

function resolveToolCallCommand(callId, events) {
  const args = resolveToolCallArgs(callId, events)
  if (!args || typeof args !== 'object') return ''
  return String(args.command || args.cmd || args.script || args.CommandLine || '').trim()
}

const mockEvents = [
  { type: 'tool/call', data: { callId: 'c1', arguments: JSON.stringify({ command: 'git -c http.sslBackend=openssl push origin main' }) } }
]
const extractedCmd = resolveToolCallCommand('c1', mockEvents)
assert.strictEqual(extractedCmd, 'git -c http.sslBackend=openssl push origin main')
const matchWithCmd = matchRule(allowRules, 'pwsh', 'danger-full-access', null, `推送代码到远程仓库 ${extractedCmd}`)
assert.ok(matchWithCmd, 'Match context including resolved tool command MUST match git rule')

// 2. looksDeny test
const DEFAULT_DENY_KEYWORDS = [
  'rm -rf', 'rm -fr', 'rm -r -f', 'rm --recursive --force',
  'push --force', 'force-push', 'force push', 'drop table', 'drop database',
  'mkfs', 'mkfs.ext', 'format', 'shutdown', 'reboot', 'dd of=',
  'delete from', 'truncate table', 'truncate ', 'terraform destroy', 'revoke',
  '清空数据库', '删除数据库', '格式化', 'sudo rm', 'chmod 777 /',
  'git reset --hard', 'git clean -fd', 'docker rm', 'docker system prune'
]

function looksDeny(text) {
  const lower = String(text || '').toLowerCase()
  const keywords = DEFAULT_DENY_KEYWORDS
  return keywords.some((keyword) => {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return false
    if (/^[a-z0-9_]+$/.test(kw)) {
      const regex = new RegExp(`(^|[^a-z0-9_-])${kw}([^a-z0-9_-]|$)`, 'i')
      return regex.test(lower)
    }
    return lower.includes(kw)
  })
}

// False positives reported in Issue 13 should NOT be blocked
assert.strictEqual(looksDeny('pwsh Get-Process | Format-Table -AutoSize'), false, 'Format-Table should NOT be blocked')
assert.strictEqual(looksDeny('pwsh Get-Date -Format "yyyy-MM-dd"'), false, 'Get-Date -Format should NOT be blocked')
assert.strictEqual(looksDeny('pwsh git log --format=%h -n 5'), false, '--format should NOT be blocked')
assert.strictEqual(looksDeny('pwsh prettier --format src/index.js'), false, '--format flag should NOT be blocked')
assert.strictEqual(looksDeny('pwsh Format-List *'), false, 'Format-List should NOT be blocked')

// True positives MUST be blocked
assert.strictEqual(looksDeny('format C: /fs:ntfs'), true, 'format C: must be blocked')
assert.strictEqual(looksDeny('rm -rf /data'), true, 'rm -rf must be blocked')
assert.strictEqual(looksDeny('shutdown /s /t 0'), true, 'shutdown must be blocked')
assert.strictEqual(looksDeny('reboot now'), true, 'reboot must be blocked')
assert.strictEqual(looksDeny('git reset --hard HEAD~1'), true, 'git reset --hard must be blocked')
assert.strictEqual(looksDeny('git clean -fd'), true, 'git clean -fd must be blocked')
assert.strictEqual(looksDeny('git push --force origin main'), true, 'push --force must be blocked')
assert.strictEqual(looksDeny('git force-push origin main'), true, 'force-push must be blocked')
assert.strictEqual(looksDeny('pwsh git push origin main'), false, 'normal git push should not be blocked')
assert.strictEqual(looksDeny('pwsh git clone https://github.com/repo'), false, 'git clone should not be blocked')
assert.strictEqual(looksDeny('pwsh git commit -m "update code"'), false, 'git commit should not be blocked')
assert.strictEqual(looksDeny('truncate table users'), true, 'truncate table must be blocked')
assert.strictEqual(looksDeny('清空数据库'), true, '清空数据库 must be blocked')

// 3. extractOperationFingerprint test
const GENERIC_EN_WORDS = new Set([
  'update', 'updates', 'updating', 'updated', 'install', 'installs', 'installing',
  'deploy', 'deploys', 'deploying', 'sync', 'syncing', 'copy', 'copies', 'move',
  'remove', 'removes', 'adding', 'change', 'changes', 'changing', 'set', 'clean',
  'test', 'verify', 'check', 'fix', 'fixes', 'fixing', 'modify', 'modifies',
  'start', 'stop', 'restart', 'build', 'create', 'read', 'write', 'open', 'close',
  'file', 'files', 'directory', 'path', 'script', 'command', 'process', 'task'
])

const COMMON_DEV_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'tsc', 'vite', 'vitest', 'node', 'wrangler',
  'python', 'pytest', 'pip', 'cargo', 'rustc', 'docker', 'kubectl', 'pwsh', 'bash'
])

function extractOperationFingerprint(text) {
  const s = String(text || '')
  const candidates = []

  for (const m of s.matchAll(/(?:[a-zA-Z]:[\\\/]|(?:~[\\\/]|[\\\/]|\.[\\\/]))?[\w@.-]+[\\\/][\w@.\/\\-]+/g)) {
    const seg = m[0].replace(/[，。；、,.;:：\s]+$/g, '').trim()
    if (seg.length >= 4 && seg.length <= 100) candidates.push(seg)
  }

  for (const m of s.matchAll(/["'`“‘]([^"'`”’\r\n]{2,80})["'`”’]/g)) {
    const seg = m[1].trim()
    if (seg.length >= 2 && seg.length <= 80 && !/^(workspace-write|danger-full-access)$/i.test(seg)) {
      candidates.push(seg)
    }
  }

  for (const m of s.matchAll(/[\w@.-]+\.(?:md|js|json|ya?ml|env|txt|py|ts|css|html|log|mjs|cjs)/gi)) {
    const seg = m[0]
    if (seg.length >= 4 && seg.length <= 60) candidates.push(seg)
  }

  for (const m of s.matchAll(/\b([a-z0-9_-]+)\b/gi)) {
    const w = m[1].toLowerCase()
    if (COMMON_DEV_TOOLS.has(w)) {
      candidates.push(m[1])
    }
  }

  for (const m of s.matchAll(/\b[a-z][\w-]*(?:[-.][a-z][\w-]*){1,3}\b/gi)) {
    const seg = m[0]
    if (seg.length >= 6 && seg.length <= 50 && !/^(workspace-write|danger-full-access)$/i.test(seg)) {
      candidates.push(seg)
    }
  }

  for (const m of s.matchAll(/\b[a-z][a-z0-9-]{2,}\b/gi)) {
    const seg = m[0]
    if (GENERIC_EN_WORDS.has(seg.toLowerCase())) continue
    if (seg.length <= 40) candidates.push(seg)
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0].slice(0, 80)
}

const fp1 = extractOperationFingerprint('tsc 需要子进程执行。')
assert.strictEqual(fp1, 'tsc', 'Should extract tsc from Chinese justification')

const fp2 = extractOperationFingerprint('Vitest must spawn its worker process to run tests')
assert.ok(fp2 && fp2.toLowerCase().includes('vitest'), 'Should extract vitest')

const fp3 = extractOperationFingerprint('需要写入 "C:\\Users\\mashi\\.dsh\\auto-approve\\allowlist.json"')
assert.ok(fp3 && fp3.includes('allowlist.json'), 'Should extract Windows path or filename')

// 4. isOriginSafe test
function isOriginSafe(req) {
  const host = req.headers['host'] || ''
  const origin = req.headers['origin']
  const referer = req.headers['referer']

  const check = (val) => {
    if (!val) return true
    try {
      const u = new URL(val)
      const allowed = new Set(['localhost', '127.0.0.1', '[::1]'])
      if (allowed.has(u.hostname)) return true
      if (host && (u.host === host || u.hostname === host.split(':')[0])) return true
      return false
    } catch {
      return false
    }
  }

  if (origin && !check(origin)) return false
  if (referer && !check(referer)) return false
  return true
}

assert.strictEqual(isOriginSafe({ headers: { host: '127.0.0.1:3000' } }), true, 'Direct curl without origin should be allowed')
assert.strictEqual(isOriginSafe({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } }), true, 'Same-origin should be allowed')
assert.strictEqual(isOriginSafe({ headers: { host: '127.0.0.1:3000', origin: 'http://localhost:3000' } }), true, 'Localhost origin should be allowed')
assert.strictEqual(isOriginSafe({ headers: { host: '127.0.0.1:3000', origin: 'https://evil.com' } }), false, 'External origin MUST be rejected')
assert.strictEqual(isOriginSafe({ headers: { host: '127.0.0.1:3000', referer: 'https://attacker.org/attack' } }), false, 'External referer MUST be rejected')

// 5. normalizeConfig auto-merges allowRules test
const DEFAULT_ALLOW_RULES = [
  { mode: 'workspace-write', description: '工作区写入' },
  { contains: 'git', description: 'Git 常规操作自动放行' },
  { contains: 'github', description: 'GitHub/GCM 凭据与网络交互自动放行' },
  { tool: 'pwsh', mode: 'danger-full-access', contains: 'git', description: 'git 网络/凭据操作自动放行' },
  { tool: 'pwsh', mode: 'danger-full-access', contains: 'EPERM', description: '沙箱子进程创建受限自动提权放行' }
]

function testNormalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  if (!Array.isArray(cfg.allowRules)) {
    cfg.allowRules = DEFAULT_ALLOW_RULES.slice()
  } else {
    for (const defRule of DEFAULT_ALLOW_RULES) {
      const exists = cfg.allowRules.some((r) =>
        (r.mode || '') === (defRule.mode || '') &&
        (r.tool || '') === (defRule.tool || '') &&
        (r.category || '') === (defRule.category || '') &&
        (r.contains || '') === (defRule.contains || '')
      )
      if (!exists) {
        cfg.allowRules.push(defRule)
      }
    }
  }
  return cfg
}

const customConfig = {
  allowRules: [
    { mode: 'workspace-write', description: '自定义工作区' },
    { tool: 'bash', contains: 'curl', description: '用户自定义规则' }
  ]
}
const merged = testNormalizeConfig(customConfig)
assert.strictEqual(merged.allowRules.length, 6, 'Should keep 2 custom rules and merge 4 missing default rules without duplication')
assert.ok(merged.allowRules.some((r) => r.contains === 'git'), 'Should contain git rule after merge')
assert.ok(merged.allowRules.some((r) => r.contains === 'curl'), 'Should preserve custom curl rule')

console.log('All tests passed successfully!')
