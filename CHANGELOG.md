# 更新日志

本文件记录 dsh-approval-gate 的重要变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

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
