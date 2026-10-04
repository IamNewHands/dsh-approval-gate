/**
 * zh.mjs 单元验证：审批说明中文化 + 结构化事实（describeFacts/compactFacts）的纯函数契约。
 * 运行：node test/zh.test.mjs（含在 `npm test` 里）
 */
import assert from 'node:assert/strict'
import { hasCJK, describeFacts, compactFacts, buildChineseReason } from '../src/zh.mjs'

let n = 0
const ok = (label) => { n += 1; console.log('  ok ' + label) }

// 1. 中文检测
assert.equal(hasCJK('沙箱提权'), true)
assert.equal(hasCJK('Same sandbox denial as before'), false)
assert.equal(hasCJK('mixed 中英'), true)
assert.equal(hasCJK(''), false)
assert.equal(hasCJK(null), false)
ok('hasCJK')

// ================= 结构化事实：字段齐全且可直接展示 =================
{
  const f = describeFacts({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: 'Same sandbox denial as before: msys bash cannot create its signal pipe.',
    command: 'bash -lc "pwsh -File ./audit.ps1"',
    files: ['C:\\Users\\mashi\\.dsh\\audit.ps1'],
    cwd: 'D:\\GitHub_Clone'
  })
  assert.equal(f.action, '执行命令')
  assert.equal(f.actionKey, 'exec')
  assert.equal(f.tool, 'pwsh')
  assert.equal(f.mode, 'danger-full-access')
  assert.equal(f.scopeShort, '整机')
  assert.match(f.scopeDetail, /工作区外任意路径可读写/)
  assert.deepEqual(f.paths, ['C:\\Users\\mashi\\.dsh\\audit.ps1'])
  assert.equal(f.pathText, 'C:\\Users\\mashi\\.dsh\\audit.ps1')
  assert.equal(f.pathsMissing, false)
  assert.equal(f.command, 'bash -lc "pwsh -File ./audit.ps1"')
  assert.equal(f.commandText, '命令：bash -lc "pwsh -File ./audit.ps1"')
  assert.equal(f.commandTool, true)
  assert.match(f.reason, /Same sandbox denial/)
  ok('describeFacts：命令类工具 + 整机 + 真实路径/命令')
}

// 2. 操作类型：删除 / 推送发布 / 新增写入 / 修改 / 读取 / 检索
{
  const del = describeFacts({ toolName: 'pwsh', mode: 'danger-full-access', justification: 'clean up', command: 'Remove-Item C:\\temp\\a.txt -Recurse' })
  assert.equal(del.action, '删除', 'Remove-Item must read as a deletion')
  assert.equal(del.actionKey, 'delete')
  assert.equal(describeFacts({ toolName: 'bash', justification: 'wipe', command: 'rm -rf /tmp/x' }).action, '删除')
  assert.equal(describeFacts({ toolName: 'bash', justification: 'push', command: 'git push origin main' }).action, '推送/发布')
  // 带 -c 选项的 git push 同样要认出来（真实场景：git -c http.sslBackend=openssl push origin main）
  assert.equal(describeFacts({ toolName: 'pwsh', justification: 'push', command: 'git -c http.sslBackend=openssl push origin main' }).action, '推送/发布')
  assert.equal(describeFacts({ toolName: 'write', justification: 'write it' }).action, '新增/写入')
  assert.equal(describeFacts({ toolName: 'edit', justification: 'edit it' }).action, '修改')
  assert.equal(describeFacts({ toolName: 'read', justification: 'read it' }).action, '读取')
  assert.equal(describeFacts({ toolName: 'grep', justification: 'search it' }).action, '检索')
  assert.equal(describeFacts({ toolName: 'mcp__fs.write_file', justification: 'write it' }).action, '新增/写入',
    'namespaced tool names fall back to their tail segment')
  ok('操作类型：删除 / 推送发布 / 新增写入 / 修改 / 读取 / 检索')

  const remoteWins = describeFacts({ toolName: 'bash', justification: 'deploy', command: 'rm -rf build && git push --force origin main' })
  assert.equal(remoteWins.action, '删除', 'irreversible deletion outranks a remote write in the same command')
}

// 3. 缺失事实：命令类工具写明 host未提供；write/edit 没有命令行这回事
{
  const bare = describeFacts({ toolName: 'pwsh', mode: 'danger-full-access', justification: 'Needs a wider sandbox.' })
  assert.equal(bare.commandText, '命令：host未提供')
  assert.equal(bare.commandTool, true)
  assert.equal(bare.pathText, 'host未提供')
  assert.equal(bare.pathsMissing, true)
  assert.equal(describeFacts({ toolName: 'write', mode: 'danger-full-access', justification: 'x' }).commandText, '',
    'a write tool carries no command line at all')
  assert.equal(describeFacts({ toolName: 'terminal-bash', mode: 'danger-full-access', justification: 'x' }).commandTool, true)
  assert.equal(describeFacts({ toolName: 'write_file', mode: 'danger-full-access', justification: 'x' }).commandTool, false,
    'a write-flavoured tool name must not be mistaken for a command tool')
  ok('缺失事实：命令类写 host未提供，write/edit 无命令行')
}

// 4. 回溯命令必须标注来源，不伪装成这次调用的确切参数
{
  const f = describeFacts({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: 'Retry with full access.',
    command: 'git -C D:\\repo push origin main',
    commandSource: 'lastSameTool'
  })
  assert.equal(f.commandLabel, '回溯最近同名调用')
  assert.match(f.commandText, /^命令（回溯最近同名调用）：git -C D:\\repo push origin main$/)
  ok('回溯命令 → 标注来源')
}

// 5. 影响范围：模式 → 后果；未知模式不谎报；未提权单独成档
{
  assert.equal(describeFacts({ toolName: 'pwsh', mode: 'read-only', justification: 'x' }).scopeShort, '只读')
  assert.equal(describeFacts({ toolName: 'pwsh', mode: 'workspace-write', justification: 'x' }).scopeShort, '工作区')
  assert.match(describeFacts({ toolName: 'pwsh', mode: 'workspace-write', justification: 'x', cwd: 'D:\\GitHub_Clone' }).scopeDetail, /D:\\GitHub_Clone/)
  assert.match(describeFacts({ toolName: 'pwsh', mode: 'weird-mode', justification: 'x' }).scopeDetail, /未识别的沙箱模式：weird-mode/)
  assert.equal(describeFacts({ toolName: 'pwsh', justification: 'x' }).scopeShort, '未提权')
  ok('影响范围：只读 / 工作区 / 整机 / 未知 / 未提权')
}

// 6. compactFacts：白名单字段 + 截断，未知键不落盘
{
  const full = describeFacts({ toolName: 'write', mode: 'danger-full-access', justification: 'probe', files: ['C:\\a.txt'] })
  const compact = compactFacts(Object.assign({}, full, { scriptTag: 'should-not-survive', paths: ['C:\\a.txt'] }))
  assert.equal(compact.tool, 'write')
  assert.equal(compact.action, '新增/写入')
  assert.deepEqual(compact.paths, ['C:\\a.txt'])
  assert.equal(compact.command, undefined)
  assert.equal(compact.scriptTag, undefined, 'unknown keys must not be persisted')
  assert.equal(compactFacts(null), null)
  assert.equal(compactFacts({}), null)
  const manyPaths = compactFacts({ paths: Array.from({ length: 12 }, (_, i) => 'C:\\p' + i) })
  assert.equal(manyPaths.paths.length, 8, 'path list is capped so events.jsonl cannot grow without bound')
  ok('compactFacts：白名单字段 / 路径上限 / 未知键丢弃')
}

// ================= 宿主审批卡文案（纯文本，按字段分行） =================
// 7. 英文说明 + 提权 + 命令 + 路径：字段齐、命令与路径原样
{
  const en = buildChineseReason({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: 'Same sandbox denial as before: msys bash cannot create its signal pipe.',
    command: 'bash -lc "pwsh -File ./audit.ps1"',
    files: ['C:\\Users\\mashi\\.dsh\\audit.ps1'],
    cwd: 'D:\\GitHub_Clone'
  })
  const lines = en.split('\n')
  assert.equal(lines[0], '操作：执行命令')
  assert.equal(lines[1], '路径：C:\\Users\\mashi\\.dsh\\audit.ps1')
  assert.match(lines[2], /^影响：整机（工作区外任意路径可读写/)
  assert.equal(lines[3], '命令：bash -lc "pwsh -File ./audit.ps1"')
  assert.match(lines[4], /^原因：Same sandbox denial/)
  assert.ok(!/做什么：/.test(en), 'the old 「做什么：…」散文句式必须消失')
  assert.ok(!/沙箱提权到/.test(en), '模式已在「影响」行交代，不再重复前缀')
  assert.ok(!/undefined/.test(en))
  ok('宿主卡文案：操作/路径/影响/命令/原因 五行，无散文句式')
}

// 8. 提权缺事实：路径仍写明 host未提供；danger-full-access 的影响行点明整机
{
  const bare = buildChineseReason({ toolName: 'pwsh', mode: 'danger-full-access', justification: 'Needs a wider sandbox.' })
  assert.match(bare, /^路径：host未提供$/m)
  assert.match(bare, /^影响：整机（/m)
  assert.match(bare, /^命令：host未提供$/m)

  const bareWs = buildChineseReason({ toolName: 'pwsh', mode: 'workspace-write', justification: 'Needs workspace write.' })
  assert.match(bareWs, /^影响：工作区（/m)
  assert.ok(!/整机/.test(bareWs), 'workspace-write must not claim machine-wide access')
  ok('提权缺事实：host未提供 + 整机声明只给 danger-full-access')
}

// 9. 无命令语义的工具（write/edit）：不写「命令：host未提供」这行噪音
{
  const writeZh = buildChineseReason({
    toolName: 'write',
    mode: 'danger-full-access',
    justification: 'Write the probe file outside the workspace.',
    files: ['C:\\Users\\mashi\\Documents\\probe.txt']
  })
  assert.ok(!/命令/.test(writeZh), 'a write tool must not carry a command line at all')
  assert.match(writeZh, /^操作：新增\/写入$/m)
  assert.match(writeZh, /^路径：C:\\Users\\mashi\\Documents\\probe\.txt$/m)

  const writeNoPath = buildChineseReason({ toolName: 'edit', mode: 'danger-full-access', justification: 'Edit something.' })
  assert.ok(!/命令/.test(writeNoPath), 'edit carries no command line either')
  assert.match(writeNoPath, /^操作：修改$/m)
  assert.match(writeNoPath, /^路径：host未提供$/m)
  ok('write/edit 提权 → 无命令行，只留操作与路径')
}

// 10. 已是中文 + 提权：补事实字段，原因保留原文措辞
{
  const zh = buildChineseReason({ toolName: 'pwsh', mode: 'workspace-write', justification: '读取工作区内的报告文件。', cwd: 'D:\\GitHub_Clone' })
  assert.equal(zh, [
    '操作：执行命令',
    '路径：host未提供',
    '影响：工作区（仅工作区（D:\\GitHub_Clone）内可写，工作区外仍被拒绝）',
    '命令：host未提供',
    '原因：读取工作区内的报告文件。'
  ].join('\n'))
  ok('中文原文 + 提权 → 补字段，原因不改写')

  const zhWithFacts = buildChineseReason({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: '需要提权推送。',
    command: 'git push origin main',
    files: ['C:\\Users\\mashi\\.dsh\\profiles\\desktop']
  })
  assert.match(zhWithFacts, /^操作：推送\/发布$/m)
  assert.match(zhWithFacts, /^命令：git push origin main$/m)
  assert.match(zhWithFacts, /^路径：C:\\Users\\mashi\\\.dsh\\profiles\\desktop$/m)
  ok('中文分支同样列出命令与目标路径')
}

// 11. 已是中文、无提权前缀：不改写
assert.equal(buildChineseReason({ toolName: 'write', mode: '', justification: '写入报告文件。' }), null)
ok('纯中文非提权 → null（不改写）')

// 12. 英文、无提权模式（工具需人工审批）：只给事实字段，没有「影响」行
{
  const noMode = buildChineseReason({ toolName: 'write', mode: '', justification: 'Needs a human check here.', files: ['D:\\GitHub_Clone\\a.md'] })
  assert.match(noMode, /^操作：新增\/写入$/m)
  assert.match(noMode, /^路径：D:\\GitHub_Clone\\a\.md$/m)
  assert.match(noMode, /^原因：Needs a human check here\.$/m)
  assert.ok(!/影响：/.test(noMode), 'no escalation means no sandbox-impact line')
  assert.ok(!/沙箱提权/.test(noMode))
  ok('英文非提权 → 操作/路径/原因')
}

// 13. 超长原文截断
{
  const long = buildChineseReason({ toolName: 'pwsh', mode: 'read-only', justification: 'x'.repeat(600) })
  assert.ok(long.includes('…'))
  assert.ok(long.length < 800)
  ok('超长原文截断')
}

// 14. 真实事故样本：整机 + 无路径 + 长命令，第一眼能看出「推送/发布 + 整机」
{
  const cmd = 'cd D:\\GitHub_Clone\\newsnook-ios; "=== tree status ==="; git -c http.sslBackend=openssl status --short; git branch -f main HEAD; git checkout -q main; git -c http.sslBackend=openssl push origin main'
  const text = buildChineseReason({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: '推送 main 与 ios-layer 时需要 GCM 凭据辅助程序，受限沙箱内无法运行；用户已要求同步 v1.8.9 并发布。',
    command: cmd
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '操作：推送/发布')
  assert.equal(lines[1], '路径：host未提供')
  assert.match(lines[2], /^影响：整机（/)
  assert.match(lines[3], /^命令：cd D:\\GitHub_Clone\\newsnook-ios/)
  assert.match(lines[4], /^原因：推送 main 与 ios-layer/)
  ok('真实事故样本 → 4 字段一眼可读（替换掉原来那段散文）')
}

// 15. 目标定域：绝对路径目标排在工作区路径之前，且定域结论单独成行
{
  const inside = describeFacts({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: '推送修复。',
    command: 'cd D:\\GitHub_Clone\\x; git push origin main',
    files: ['IamNewHands/dsh-approval-gate'],
    targets: ['D:\\GitHub_Clone\\x'],
    targetScope: 'inside'
  })
  assert.deepEqual(inside.paths, ['D:\\GitHub_Clone\\x', 'IamNewHands/dsh-approval-gate'],
    'absolute targets come first; the write-target list is appended, not replaced')
  assert.equal(inside.targetScope, 'inside')
  assert.equal(inside.targetScopeText, '工作区内')
  assert.equal(inside.pathsMissing, false)

  assert.equal(describeFacts({ toolName: 'pwsh', targetScope: 'outside' }).targetScopeText, '工作区外')
  assert.equal(describeFacts({ toolName: 'pwsh', targetScope: 'mixed' }).targetScopeText, '跨工作区内外')
  assert.equal(describeFacts({ toolName: 'pwsh', targetScope: 'unknown' }).targetScopeText,
    '无法定域（没有绝对路径）', 'unknown must be spelled out, never left blank')
  assert.equal(describeFacts({ toolName: 'pwsh' }).targetScopeText, '',
    'no scope information at all → no line (old events stay unchanged)')
  assert.equal(describeFacts({ toolName: 'pwsh', targetScope: 'inside', targetTraversal: true }).targetScopeText,
    '工作区内 · 含 .. 穿越', 'a traversal is spelled out next to the scope')
  assert.equal(describeFacts({ toolName: 'pwsh', targetScope: 'outside', targetTraversal: true }).targetScopeText,
    '工作区外', 'outside already covers the traversal — no redundant suffix')

  const compact = compactFacts(inside)
  assert.equal(compact.targetScope, 'inside')
  assert.equal(compact.targetScopeText, '工作区内')
  assert.equal(compactFacts(describeFacts({ toolName: 'pwsh', targetTraversal: true })).targetTraversal, true)
  assert.equal(compactFacts(describeFacts({ toolName: 'pwsh' })).targetScope, undefined,
    'a call with no scope information must not invent one')

  const text = buildChineseReason({
    toolName: 'pwsh',
    mode: 'danger-full-access',
    justification: '备份并写入工作区外的 Clash 覆写配置。',
    command: 'Copy-Item "C:\\Users\\shiro\\AppData\\Roaming\\x\\Merge.yaml" "C:\\Users\\shiro\\AppData\\Roaming\\x\\Merge.yaml.bak"',
    targets: ['C:\\Users\\shiro\\AppData\\Roaming\\x\\Merge.yaml'],
    targetScope: 'outside'
  })
  const lines = text.split('\n')
  assert.match(lines[0], /^操作：/)
  assert.match(lines[1], /^路径：C:\\Users\\shiro\\AppData\\Roaming\\x\\Merge\.yaml/)
  assert.equal(lines[2], '目标：工作区外', 'the scope line sits right under the path line')
  assert.match(lines[3], /^影响：整机（/)
  ok('目标定域：paths 合并顺序 / 四态文案 / 穿越标注 / 紧凑事实白名单 / 卡文案行序')
}

// ================= 16. 操作类型标注：`format` 只认磁盘格式化 =================
{
  // 现场发现（2026-10-04）：裸 `\bformat\b` 把 `Get-Date -Format o` / `Format-List` /
  // `--json … format` 判成「删除」，审计表的「操作类型」行骗人 —— 而那一行正是审批人
  // 第一眼判断风险的依据。实测 1219 条事件里 13 条被这么误标。
  const key = (command) => describeFacts({ toolName: 'pwsh', command }).actionKey

  assert.notEqual(key('$p = "x"; Set-Content -LiteralPath $p -Value "0.9.8 live probe $(Get-Date -Format o)"'), 'delete',
    'Get-Date -Format must not be labelled as a deletion')
  assert.notEqual(key('gh run view 123 --json status | ConvertFrom-Json | Format-List'), 'delete',
    'Format-List must not be labelled as a deletion')
  assert.notEqual(key('$stamp = Get-Date -Format "yyyyMMdd-HHmmss"'), 'delete',
    'a -Format timestamp must not be labelled as a deletion')

  // 真正的破坏形态仍然标成「删除」
  assert.equal(key('format C: /q'), 'delete', 'formatting a drive is still a deletion')
  assert.equal(key('format /fs:ntfs D:'), 'delete', 'format with a flag is still a deletion')
  assert.equal(key('Format-Volume -DriveLetter D'), 'delete', 'Format-Volume is still a deletion')
  assert.equal(key('Remove-Item C:\\temp\\a.txt -Recurse'), 'delete', 'Remove-Item is still a deletion')
  assert.equal(key('rm -rf ./dist'), 'delete', 'rm -rf is still a deletion')
  assert.equal(key('git reset --hard HEAD~1'), 'delete', 'git reset --hard is still a deletion')
  assert.equal(key('shutdown /s /t 0'), 'delete', 'shutdown is still a deletion')

  // 普通命令落到「执行命令」，不因为 `format` 的子串而变成「删除」
  assert.equal(key('npm test 2>&1 | Select-Object -Last 20'), 'exec', 'an ordinary command stays 执行命令')
  ok('操作类型标注：`format` 只认磁盘格式化（-Format / Format-List 不再误标「删除」）')
}

console.log('\nzh.mjs: ' + n + ' 组断言全部通过')
