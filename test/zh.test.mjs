/**
 * zh.mjs 单元验证：审批说明中文化的纯函数契约。
 * 运行：node test/zh.test.mjs（含在 `npm test` 里）
 */
import assert from 'node:assert/strict'
import { hasCJK, buildChineseReason } from '../src/zh.mjs'

let n = 0
const ok = (label) => { n += 1; console.log('  ok ' + label) }

// 1. 中文检测
assert.equal(hasCJK('沙箱提权'), true)
assert.equal(hasCJK('Same sandbox denial as before'), false)
assert.equal(hasCJK('mixed 中英'), true)
assert.equal(hasCJK(''), false)
assert.equal(hasCJK(null), false)
ok('hasCJK')

// 2. 英文说明 + 提权模式 + 命令：必须全中文说明 + 命令原样
const en = buildChineseReason({
  toolName: 'pwsh',
  mode: 'danger-full-access',
  justification: 'Same sandbox denial as before: msys bash cannot create its signal pipe.',
  command: 'bash -lc "pwsh -File ./audit.ps1"',
  files: ['C:\\Users\\mashi\\.dsh\\audit.ps1'],
  cwd: 'D:\\GitHub_Clone'
})
assert.match(en, /沙箱提权到 danger-full-access/)
assert.match(en, /可读写工作区之外的任意路径/)
assert.match(en, /做什么：命令：bash -lc "pwsh -File \.\/audit\.ps1"/)
assert.match(en, /目标路径：C:\\Users\\mashi\\\.dsh\\audit\.ps1/)
assert.match(en, /模型说明原文（未翻译）：Same sandbox denial/)
assert.ok(!/爆|undefined/.test(en))
ok('英文 → 中文说明（含后果/做什么/原文）')

// 3. 已是中文 + 提权模式：去掉宿主英文前缀，保留原文
const zh = buildChineseReason({ toolName: 'pwsh', mode: 'workspace-write', justification: '读取工作区内的报告文件。', cwd: 'D:\\GitHub_Clone' })
assert.equal(zh, '沙箱提权到 workspace-write：读取工作区内的报告文件。')
ok('中文原文 + 前缀本地化')

// 4. 已是中文、无提权前缀：不改写
assert.equal(buildChineseReason({ toolName: 'write', mode: '', justification: '写入报告文件。' }), null)
ok('纯中文非提权 → null（不改写）')

// 5. 英文、无提权模式（工具需人工审批）：点名工具与目标
const noMode = buildChineseReason({ toolName: 'write', mode: '', justification: 'Needs a human check here.', files: ['D:\\GitHub_Clone\\a.md'] })
assert.match(noMode, /工具 write 的本次调用超出自动放行范围/)
assert.match(noMode, /目标路径：D:\\GitHub_Clone\\a\.md/)
ok('英文非提权 → 中文说明')

// 6. 工作区模式带上会话工作区
assert.match(
  buildChineseReason({ toolName: 'pwsh', mode: 'workspace-write', justification: 'Write inside workspace.' }),
  /可修改工作区内的文件/
)
ok('workspace-write 后果说明')

// 7. 超长原文截断
const long = buildChineseReason({ toolName: 'pwsh', mode: 'read-only', justification: 'x'.repeat(600) })
assert.ok(long.includes('…'))
assert.ok(long.length < 800)
ok('超长原文截断')

// 8. 未知模式：不谎报后果
assert.match(buildChineseReason({ toolName: 'pwsh', mode: 'weird-mode', justification: 'English.' }), /请求的沙箱模式：weird-mode/)
ok('未知模式回退')

console.log('\nzh.mjs: ' + n + ' 组断言全部通过')
