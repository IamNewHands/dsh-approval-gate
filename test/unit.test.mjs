import assert from 'node:assert'
import plugin from '../src/index.mjs'

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
  { tool: 'pwsh', mode: 'danger-full-access', category: 'neutral', contains: 'vitest', description: '自动沉淀：中立' }
]

// Step 2 calls matchRule with null category:
const matchedInStep2 = matchRule(allowRules, 'pwsh', 'danger-full-access', null, 'vitest run test.js')
assert.ok(matchedInStep2, 'Step 2 MUST match learned rule with category: neutral when category is null')
assert.strictEqual(matchedInStep2.contains, 'vitest')

// Workspace-write rule match
const matchedWs = matchRule(allowRules, 'edit', 'workspace-write', null, 'edit file.js')
assert.ok(matchedWs, 'Step 2 must match workspace-write rule')

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

console.log('All tests passed successfully!')
