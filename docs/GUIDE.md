# dsh-approval-gate 完整指南

> 首页：[简体中文](../README.md) · [English](../README.en.md) · 指南：[中文](GUIDE.md) · [English](GUIDE.en.md)

DeepSeek Harness 自动审批门控插件 v0.7.1：**最小人工介入，只把必须人工确认的操作转人工（fail-safe）**。

当会话的权限预设为 `auto-approve`（自动审批（Flash））时，每次审批请求（沙箱越界）按管道判定：

```
硬拒（凭据外泄 / 根与系统路径销毁）→ 硬事实人工（DSH_HOME / home 根）
  → DENY（不可逆危险词）→ 白名单（确定性规则）→ denyRules（裁决拒绝升级）
  → 脱敏 → 判定（JSON allow/ask/deny，硬类别 / 中立确认 / 失败计数）→ 学习沉淀
```

- **⓪ 硬拒层**（吸收自 [dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)，**最高优先，判定模型无权推翻**）：基于工具参数的**真实路径与凭据事实**判定，而非 justification 关键词
  - **直接拒绝档**（不弹窗，让 agent 改方案）：
    - **凭据外泄**：对外调用（`web_fetch` / `web_search` / `curl` / `wget`，或 deploy/publish/push/send/release 类工具名）的参数中携带凭据材料；或其 URL 带密码、或带 8 字符以上的 `token`/`api_key`/`signature`/`auth` 查询参数
    - **破坏性目标**：文件系统根（`/`、`C:\`）；操作系统或凭据关键路径（`/etc`、`/bin`、`/sbin`、`/usr`、`/system`、`/library`、`/boot`、`C:\Windows`、`C:\Program Files`、`C:\ProgramData`、`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.config/gcloud`）；Windows 设备/NT 命名空间（`\\.\`、`\Device\`、`\\?\`、`\??\`）；Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`）；含义不明的盘符相对路径
  - **人工档**（保留手动放行能力）：目标为 `$DSH_HOME` 或用户 home 根本身
  - 常规工作区操作不受影响，绝不被硬拒
- **① DENY 层**：`rm -rf` / `drop table` / `force push` / 格式化等不可逆危险词命中 → 转人工（fail-safe）
- **② 白名单层**：命中规则 → 直接放行（确定性，不过 LLM）。默认规则 `{mode:"workspace-write"}` —— 工作区写入（可回补）自动放行；也支持 `tool/mode/category/contains` 组合规则（含学习沉淀的规则）
- **③ denyRules 层**：此前用户**裁决拒绝**过的「工具+模式+类别」→ 永久转人工（不会自动放行用户明确拒绝过的操作）
- **④ 脱敏**（吸收自 dsh-auto-mode）：送判定模型前先抹除密钥、截断大块正文（见下文「判定输入脱敏」）
- **⑤ 判定**（仅越界请求）：输出**严格 JSON** `{decision, reason, category}`
  - **硬风险类别最先裁决**（`deletion` 删除 / `credential` 凭据 / `remote` 远程生产 / `system` 系统路径 / `bulk` 批量不可回补）→ **直接转人工**（必须人工确认，不计数、不学习）。这是一道**对称安全闸**：无论模型给 `allow` 还是 `deny`，命中硬类别一律转人工，模型的裁决不能绕过它
  - `decision: "deny"` 且类别为 `neutral` → **静默拒绝**（不弹窗），agent 应改换更安全的方案；该记录会常驻提示条，可在审批视图里**追认**（见下文）
  - `decision: "allow"` → 自动放行
  - `decision: "ask"` → 转人工
  - `neutral`（中立，无硬风险特征）→ **人工确认制**：前 N 次转人工确认，之后进入阈值状态
  - 判定器**连续失败计数**（吸收自 dsh-auto-mode）：前 2 次静默拒绝，第 3 次转一次人工；成功一次即清零
- **⑥ 学习沉淀**（neutral 类别，N=3 时：前 3 次人工确认，第 4 次起进入阈值状态）
  - 阈值前：一律人工确认，**批准** → 计数 +1 并记录**操作样本**（指纹 + 操作背景/目的）；**拒绝** → 升级 denyRules
  - 阈值状态（计数 ≥ N）三种分流：
    1. **指纹确定性命中**（本次操作在确认样本中）→ 自动放行 + 沉淀 `{tool, mode, category, contains}` 规则
    2. **指纹未命中但有确认样本** → 把本次操作的背景/目的 + 用户确认过的样本交给 flash **第三方同类验证**：判 `SAME`（与已确认样本同类）→ 自动放行（有指纹则沉淀）；判 `DIFFERENT`/验证失败 → 人工确认
    3. **无确认样本** → 人工确认
  - 用户**拒绝** → 升级进 denyRules（带指纹；提取不到指纹则拦全部同类，拒绝从严）
  - 取消/不可用 → 不计数（用户未表态，下次仍人工确认）
  - 硬类别/DENY/验证失败永远人工，同类验证只作用于 neutral 阈值状态

## 安装

```sh
# 从本仓库安装（推荐）
dsh plugin --profile web add "github:IamNewHands/dsh-approval-gate#main"
```

> 注意：npm 上的 `dsh-approval-gate` 仍是上游 0.5.0，不含本仓库的修复，请勿按包名安装。

## ⚠️ 安装后必须手动配置权限预设（关键步骤）

插件无法向权限预设表添加选项（预设表在配置构造时冻结），需要手动在 profile 的 `cordis.patch.yml` 中补一条 preset：

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加（或合并进已有的 `permission` 行——**loader 的 patch 会整体替换目标行的 config，若已有该行必须重述全部预设**）：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      auto-approve:
        sandbox: workspace-write
        approval: ask
        name: 自动审批（Flash）
        description: 多级判定：工作区写入自动放行，危险操作转人工审批。
```

重启 `dsh web` 后，权限下拉菜单会出现「自动审批（Flash）」选项。

## 配置（可选）

数据文件统一放在 `$DSH_HOME/auto-approve/`（默认 `~/.dsh/auto-approve/`）：

| 文件 | 说明 |
|------|------|
| `allowlist.json` | 白名单/黑名单/阈值配置（首次运行自动生成默认值，旧版自动迁移，修改即时生效无需重启） |
| `learning.json` | 学习状态（自动维护，跨会话持久化） |
| `audit.log` | 审计日志（追加式） |
| `events.jsonl` | 自动放行事件（供审查 UI 展示，按会话隔离） |
| `snapshots/` | 自动放行文件的改动前快照（按事件 ID 命名，供 diff 对比与撤销参考） |

`allowlist.json` 结构（v4）：

```json
{
  "version": 4,
  "denyKeywords": ["rm -rf", "drop table", "force push", "格式化"],
  "allowRules": [
    { "mode": "workspace-write", "description": "工作区写入自动放行" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "特定工具+模式+关键词" }
  ],
  "denyRules": [],
  "hardCategories": ["deletion", "credential", "remote", "system", "bulk"],
  "riskyThreshold": 3,
  "judgeTimeoutMs": 20000,
  "judgeFailureLimit": 3,
  "judgeModel": { "provider": "my-provider", "model": "my-flash-model" },
  "learning": { "enabled": true }
}
```

### 判定输入脱敏（吸收自 dsh-auto-mode）

判定模型收到的是**脱敏后**的参数与理由，避免密钥随判定请求出站到模型端点：

| 类别 | 处理 |
|------|------|
| 私钥块、`AKIA`/`ASIA`、`ghp_`/`github_pat_`、`xoxb` 等令牌、`Bearer <token>`、`api_key=`/`token=`/`secret=`/`password=` | → `[redacted-secret]` |
| 文本长度 | 截断到 1000 字符 |
| 密钥类字段名（`api_key` / `authorization` / `password` / `token` / `cookie` / `secret` / `credential` / `private*`） | 整字段 → `[redacted-secret-field]` |
| 大块正文字段（`body` / `content` / `data` / `diff` / `input` / `patch` / `payload` / `str` / `string` / `text`，以及恒脱敏的 `description` / `justification`） | → `[redacted-<字段>:<长度>-chars]` |
| 结构边界 | 递归深度 3、数组 25 项、对象 50 键 |

若**工作区路径本身**含密钥形态（脱敏会改写它），说明精确目标无法安全披露给判定模型 → 该请求直接转人工。

### 授权来源（吸收自 dsh-auto-mode）

判定模型只承认**直接人类消息**为授权来源（最多 4 条、逐条脱敏、总预算 4000 字符）。
仓库内容、工具输出、assistant 文本、skill / 插件 / 子代理文本**一律不构成授权**。

### 提示层减负（吸收自 dsh-auto-mode）

预设激活期间，插件向会话动态上下文注入 `<auto_approve_policy>`（顺序紧随宿主自身的沙箱策略），告知 agent：
常规工作直接走沙箱、删除是最高风险操作、删除授权不得泛化到变量/通配符/父目录/兄弟路径/第二个目标、
未明确要求永久删除时优先可回滚方案、凭据读取与对外发送需精确授权、命中硬拒不弹窗应改方案。
目的是从源头减少需要判定的越界请求，而不是在审批层反复拦截。

### 多机共享规则

插件包内（仓库根目录）的 `allowlist.json` 是**汇总版规则**。每次加载时，其中的规则数组
（`denyKeywords` / `allowRules` / `denyRules` / `hardCategories`）会**增量并入**本地
`$DSH_HOME/auto-approve/allowlist.json`，因此多台机器共用同一份规则：

- **只增不减**：本机自定义规则保留，不会被仓库版本覆盖或删除
- **按特征去重**：同一规则（`tool`/`mode`/`category`/`contains` 四元组）不会重复追加
- **幂等**：重复加载不会产生重复条目
- **版本以仓库为准**：`version` 跟随汇总文件，本机不会自行降级

以下配置属于**机器本地**，不参与同步（各机按实际环境自行设置）：

- `riskyThreshold`、`judgeTimeoutMs`、`judgeFailureLimit`、`learning`
- `judgeModel`：判定模型。各机的自定义提供商名称可能不同（如 `my-provider`），
  必须按本机实际配置填写，不要照搬另一台机器的值

> 旧版本（上游 0.5.0）使用的 `model` 字段已更名为 `judgeModel`。加载时会自动迁移：
> 保留本机原有取值写入 `judgeModel`，并移除旧的 `model` 键；若已显式配置
> `judgeModel`，则以它为准。

- `denyKeywords`：命中即转人工（不可逆危险操作）
- `allowRules`：每条规则 `tool` / `mode` / `category` / `contains` 均满足才放行（缺省表示任意）。学习沉淀的规则也会写入这里
- `denyRules`：用户裁决拒绝后自动写入，命中即转人工（不学习）
- `hardCategories`：判定为这些类别 → 直接转人工（不计数、不学习）；即使判定模型给出 `allow`，命中硬类别也强制转人工
- `riskyThreshold`：中立类别的人工确认阈值（默认 3）——同一「工具+模式+类别」被人工确认 N 次后，第 N+1 次起自动放行并沉淀规则
- `judgeTimeoutMs`：单次判定超时（默认 20000ms，超时自动重试 1 次）
- `judgeFailureLimit`：判定器**连续失败**多少次后转一次人工（默认 3）。前 2 次失败静默拒绝让 agent 改方案，第 3 次转人工，避免判定器长期不可用时卡死任务；判定成功一次即清零

## 使用

在会话的权限下拉（`/permission` 弹窗或设置页）选中**「自动审批（Flash）」**，该会话即启用自动审批；其他会话不受影响（按会话预设门控）。

## 设置页（v0.4.1+）

DSH 设置面板新增「自动审批」分区（settings.section，样式与 DSH 原生设置一致），按管道顺序提供可视化规则管理，每张卡片标注管道阶段：

- **初始化卡片**：检测 `cordis.patch.yml` 是否已含 auto-approve 权限预设；未配置时点「一键配置」自动写入（文本级修改，保留注释格式），重启后生效
- **管道总览**：判定链路 + 生效的硬风险类别徽标
- **① DENY 层 · 黑名单**（denyKeywords）：查看/添加/删除危险词（删除预置词有确认提示）
- **② 白名单层 · 白名单**（allowRules）：查看（预置/学习沉淀/用户 来源标签）/添加（tool/mode/category/contains 表单）/删除 —— 例：`tool=edit, mode=danger-full-access` → 工作区外 edit 自动放行
- **③ denyRules 层 · 永久人工**：拒绝升级的规则，查看/移除
- **④ Flash 判定 · 阈值与超时**：`riskyThreshold`（学习满 N 次后第 N+1 次自动放行）/ `judgeTimeoutMs` 直接修改
- **⑤ 学习沉淀 · 正在学习**：展示确认计数（n/N）与样本；**「终止」按钮可介入删除**（删除计数与样本，重新学习）

所有修改通过 `POST /api/auto-approve/rules` 写入 `allowlist.json`，**热更新即时生效**（无需重启）；`POST /api/auto-approve/setup` 负责一键初始化。

## 人工审查 UI（v0.4.0+）

每次命令被自动放行或转人工审批时，提供审查入口（严格按 DSH 设计语言，`--dsw-alias-*` tokens）：

1. **提示条**（输入框上方独立一行，`conversation.input.dock` order=30，不随流式对话滚动）：
   - 自动放行 → 绿色 ✅：工具 + 摘要 + 判定路径（白名单规则 / Flash 判定安全 / 沉淀规则 / 已确认操作 / Flash 同类验证），几秒后收起
   - **转人工审批 → 橙黄色**（`--dsw-alias-state-warn-*`）：显示「等待人工审批：<操作>」，**不自动收起**，直到你确认
   - **静默拒绝 / 人工拒绝 → 红色**（v0.7.0+）：显示「已直接拒绝：<操作>」或「已拒绝：<操作>」，**不自动收起**——一直挂在对话框上方，直到你切到「审批」tab 或按下处理按钮。已追认的拒绝不算待处理，刷新时不会作为红色提示条恢复，提示条文案也随之翻转为「已追认放行」（v0.7.1）。提示条右侧提供：
     - **「查看审批记录」**：切到「审批」tab（等于已读，提示条随即收起）
     - **「重新审批通过」**：仅在该拒绝**可追认**时出现（见下文），点了就写入自动放行规则并让 AI 重试该操作
   - 人工通过 → 橙黄「学习 n/N，满 N 次后自动放行」（几秒后收起）
   - 打开会话时只恢复**未读的拒绝**，不弹自动放行的历史记录
   - 已读位置按会话持久化在浏览器 `localStorage`（`dsh-approval-gate.seenRejects`）：刷新页面不会丢待处理记录，也不会重复打扰已读记录
2. **「审批」历史视图**：会话视图切换条「轨迹」右侧的「审批」tab（`conversation.view` order=20）。标题旁显示**待处理 N**（仍未追认的拒绝数）。当前会话记录（**最新在上**）：自动放行（绿 ✅）、人工通过（橙黄 + 学习计数 n/N）、人工拒绝（红）、静默拒绝（红 + 「重新审批通过」按钮）
3. **追认（「重新审批通过」，v0.7.0+）**：被拒绝的记录可以追认，效果是**写入带操作指纹的自动放行规则 + 向会话投递一条重试指令**（让 AI 重跑那个操作，不必你手敲一遍）。两道围栏：
   - **只有判定层静默拒绝可追认**：`judge-deny`（判定器 `deny` / 连续失败静默拒绝）。**确定性硬拒档**（`hard-reject`：凭据外泄、文件系统根与系统路径销毁）位于管道最前，白名单规则盖不过它——给按钮就是假承诺，因此不提供
   - **硬风险类别不可追认**：`deletion`/`credential`/`remote`/`system`/`bulk` 属于「必须每次人工确认」，不接受追认式自动放行；如需放开请改 `hardCategories` 或改用白名单规则
   - 重复追认幂等（规则不重复写入）；追认后该记录标注「已追认放行 · <原因>（曾直接拒绝）」并从待处理计数中移除（v0.7.1 起文案与配色一起翻转，不再看起来像仍在拒绝）
4. **文件改动对比与撤销**（v0.5.0+）：自动放行且涉及文件时，host 在审批（写入前）保存文件**改动前快照**；历史视图中对应事件的**文件标签变为可点击**（蓝色描边），点击弹出 diff 面板：
   - **只看变更行**：绿底 `+` 为新增行、红底 `-` 为删除行（经典 diff 语义），头部显示 +N / -M 行统计与「未变行」数；文件当前已不存在会提示
   - **撤销此改动**：向当前会话投递一条撤销指令（含操作说明、涉及文件、事件时间、快照目录位置），AI 据此把文件恢复为审批前状态
   - **diff 快照管理**：视图顶部显示「diff 快照 占用 · 条数」，并提供两个清理入口——**「仅清本会话」**（只删除当前会话的快照，不影响其他会话未查看的 diff）与**「清空全部」**（二次确认后清空所有会话；均仅删除对比数据，不影响审批记录本身，删除后历史文件不可再查看对比）
   - 限制：仅文本文件（单文件 ≤256KB、每事件 ≤5 个文件）会保存快照，二进制/超限文件不可点击

数据链路：host 每次判定追加结构化事件到 `~/.dsh/auto-approve/events.jsonl`（`kind`: auto / manual-pending / manual-approved / manual-rejected / hard-reject / judge-deny / reconsidered，含 sessionId/tool/mode/reason/justification/verdict/files/learningCount/threshold，v0.8.1 起的中文说明 `zh`，以及 v0.9.0 起的结构化事实 `facts`），浏览器通过 `GET /api/auto-approve/events?sessionId=&since=` 轮询（2s 增量 / 视图 5s 全量）。

> `zh` 是**面向审批人的中文说明**（v0.8.1+，v0.9.0 起按字段分行）：`src/zh.mjs` 用真实事实（目标模式 / 真实命令 / 真实目标路径）生成，形如「操作：删除 / 路径：C:\temp\a.txt / 影响：整机（工作区外任意路径可读写，含系统位置；改动不可自动回滚）/ 命令：Remove-Item C:\temp\a.txt / 原因：<模型原文>」；命令与路径原样保留，模型原文放在「原因」行。原文已是中文且无提权事实时不改写（返回 null）。前端优先渲染 `zh`，缺 `zh`（老事件）回退 `justification`；`justification` 永远保存原文。

> `facts` 是**结构化审批事实**（v0.9.0+）：字段为 `tool` / `action`（操作类型：删除、推送/发布、新增/写入、修改、执行命令、读取、检索、调用）/ `actionKey`（供前端配色）/ `mode` / `scopeShort`（整机、工作区、只读、未提权）/ `scopeDetail`（后果一句话）/ `paths[]`（最多 8 条）/ `pathsMissing` / `command` / `commandLabel` / `reason`。落盘前经 `compactFacts()` 白名单过滤与逐项截断，避免 `events.jsonl` 无界膨胀；**盘上缺 `facts` 的老事件由事件 API 在响应里按已记录的事实（tool / mode / files / command / justification）现算补上，不回写文件**——事件日志保留当初写下的事实。浏览器端**审批记录行优先渲染 `facts` 字段表格**（操作类型 / 操作路径 / 影响范围 / 执行命令 / 模型说明，另附非 neutral 的风险类别），`facts` 缺失的老事件回退渲染 `zh` / `justification` 文本。注意：宿主审批卡（`dsh-client-ui-approval`）把 `reason` 当纯文本渲染、不解析 Markdown/HTML 且不保留换行，因此卡片上只能显示字段分行的纯文本，**表格只存在于本插件的「审批」视图**；不注入依赖宿主内部 DOM 的 CSS，以免 DSH 升级后样式失效。

> 顶部「审批」tab 的条数（v0.9.0+）：宿主把 `conversation.view` 的 `label` 经 `resolveSlotLabel()` 的结果**当字符串**渲染 tab 文案，且只在「slot 变更 / locale 发布」时重算 tab 列表（`refreshViews` 同时订阅 `slots.subscribe` 与 `locale.subscribe`）。因此条数实现为 **label thunk 读模块级计数 + 条数真变化时发布一次 locale**（注册一次性 namespace 后立即撤销，避免「同一 namespace 不能重复 register」）。口径 = 本会话「审批」视图真正列出的行数（`manual-pending` 只活在提示条里，不计入），数字与打开 tab 后看到的行数一致。`locale` 服务不可用时退回静态「审批」，不影响审批本身。

> `hard-reject` 与 `judge-deny` 是**判定层静默拒绝**（未弹窗）：分别对应硬拒档与判定器 `deny`／连续失败。审查视图对它们显示红色「已直接拒绝」并标注具体原因。
>
> `reconsidered` 是**追认记录**（v0.7.0+）：`reconsiderOf` 指回被追认的原事件。事件 API 会过滤掉追认记录本身，并给原事件加上 `reconsidered: true`，前端据此标注「已追认放行 · …（曾直接拒绝）」并撤销待处理角标。追认不改写原事件：拒绝确实发生过，原因仍留在括号里可见（v0.7.1 文案）。

## 追认 API（v0.7.0+）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auto-approve/reconsider` | POST | `{sessionId, eventId, retry?}` → 追认一次判定层静默拒绝。写入带指纹的 `allowRules`（`description` 前缀「用户追认：」），并按 `retry !== false` 投递重试指令。返回 `{ok, rule, duplicate, delivery}`；不可追认时 400 并给出原因（`error` 说明是硬拒档还是硬风险类别） |

围栏（服务端强制，UI 只是不显示按钮）：`kind` 必须是 `judge-deny`；`category` 不得命中 `hardCategories`。

## 文件改动对比与撤销 API（v0.5.0+）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auto-approve/diff?eventId=&path=` | GET | 返回指定事件/文件的变更行（`changedLines`，add/del）与统计（`stats`），只读该事件快照中列出的路径 |
| `/api/auto-approve/revert` | POST | `{sessionId, eventId}` → 组装撤销指令投递到对应会话（typertGateway 优先，agent.followup 兜底） |
| `/api/auto-approve/snapshots-stats?sessionId=` | GET | 快照占用统计 `{count, bytes, ids, files}`（ids = 仍有快照的事件列表，用于判定哪些文件可点击；带 sessionId 时只统计该会话） |
| `/api/auto-approve/snapshots-clear` | POST | 删除快照文件（仅限 `snapshots/` 目录内 `.json`）；带 `{sessionId}` 时只清该会话，否则清空全部 |

## 学习语义（v0.3.0+）

中立操作确认制：同一「工具|模式|类别」每被人工批准一次计数 +1；**确认满 N 次（默认 3）后，第 N+1 次起自动放行**并沉淀带指纹规则。阈值状态内：指纹命中直接放行；未命中由 Flash 对照确认样本做语义同类验证（SAME 放行 / DIFFERENT 人工）；拒绝升级 denyRules 永久人工；「正在学习」可在设置页终止。

## 安全设计

1. **硬拒层最高优先且单调**（吸收自 dsh-auto-mode）：凭据外泄与根/系统路径销毁基于**路径与凭据事实**直接拒绝，判定模型无权推翻；DSH_HOME / home 根等硬事实转人工，保留手动放行能力
2. **DENY 层次优先**：不可逆危险词命中即转人工，不消耗模型调用
3. **硬风险类别永远人工（对称安全闸，v0.7.0 修正）**：`deletion`/`credential`/`remote`/`system`/`bulk` 不计数、不学习、不可被沉淀规则覆盖，也**不可被追认**；无论判定模型给 `allow` 还是 `deny`，命中硬类别一律**转人工**。此前 `deny` 分支排在硬类别之前，模型对硬类别判 `deny` 会被静默拒绝，使配置的硬类别失效——现已修复
4. **判定输入脱敏**：密钥与大块正文在送出前被抹除/截断；工作区路径含敏感形态时转人工而不外发
5. **授权来源唯一**：仅直接人类消息构成授权，仓库内容/工具输出/assistant/skill/插件/子代理文本均不能授权
6. **学习规则带类别 + 操作指纹**：沉淀的是 `{tool, mode, category, contains}`（contains = 用户确认过的操作指纹），只放行同一指纹的操作；指纹未命中时由判定模型做**语义级同类验证**（基于用户确认样本判断操作意图是否同类），判 DIFFERENT/验证失败一律人工；拒绝过的操作升级 denyRules（带指纹，提取不到则拦全部同类），永不自动放行
7. **fail-safe**：判定输出格式不合规（非 JSON、缺键、多键、非法裁决/类别、空或超长 reason）一律按失败处理；判定器连续失败前 2 次静默拒绝、第 3 次转人工，绝不自动放行硬风险
8. **可回补优先**：`workspace-write`（写工作区）默认放行，越界才走判定
9. **按会话门控**：只有显式选中「自动审批（Flash）」预设的会话才介入
10. **只预判、不执行**：插件只返回允许/拒绝/转人工决策，不修改审批流程的其他环节

> 警告：自动审批会显著降低人工介入频率。**仅供可信环境使用**，涉及生产数据、远程系统、支付扣费等高风险场景请保持 `ask` 预设。

## 技术说明

- 挂载于 `approval/request` 瀑布最前（`prepend: true`，先于 web answerer 接单）
- 门控：`permissionPresets.current(session) === 'auto-approve'`（传 Session 对象：内部走 sessionProjections.stateOf(session,'permissions')）
- DSH 审批触发点是沙箱越界，`reason` 固定为 `escalate sandbox to <mode>: <justification>`，`mode` 仅 `workspace-write` / `danger-full-access` 两级
- 判定模型：`reasoningEffort: 'off'` + `maxTokens: 256`，输出**严格 JSON** `{decision, reason, category}`（`decision` ∈ `allow`/`ask`/`deny`，`category` ∈ `deletion`/`credential`/`remote`/`system`/`bulk`/`neutral`，`reason` 非空且 ≤1000 字符）；允许 ```json 围栏，任何偏差抛错并按 fail-safe 处理
- 超时兜底：`AbortController` 传入 `llm.stream` 的 signal（可取消底层请求），`Promise.race` + `ctx.timeout(judgeTimeoutMs)`，超时 abort 并重试 1 次
- 同类验证：把当前操作背景/目的 + 用户确认样本交给 flash 语义判断（`SAME`/`DIFFERENT`），失败按 DIFFERENT 处理
- 学习闭环：通过 waterfall 的 `next()` 返回值捕获人工裁决结果（`allowed-once` 沉淀 / `rejected` 升级）
- 审查 UI：host 写 `events.jsonl` + `GET /api/auto-approve/events`（按 sessionId 过滤 + since 增量）；client 轮询展示
- 快照与 diff：审批发生在写入前，自动放行事件落盘时保存 `snapshots/<eventId>.json`（仅文本 ≤256KB、每事件 ≤5 个文件）；diff 用近似逐行匹配只返回变更行（上限 500 行）
- 撤销投递：`sendToSession` 优先 `typertGateway.invoke({namespace:'session', method:'prompt'})`（queue 模式），失败回退 `agent.followup`
- 硬拒与脱敏实现：`src/paths.mjs`（路径规范化、关键路径与破坏性目标熔断、凭据材料与外发 URL 凭据判定）+ `src/classifier.mjs`（严格 JSON 裁决解析）+ `src/sanitize.mjs`（判定输入脱敏）
- 动态系统提示：`systemPrompt.context`，`name: 'approval-gate:policy'`，顺序紧随宿主沙箱策略；文本回调对非 `auto-approve` 预设的会话返回 `''`（不注入）

## 测试

`npm test` 先对所有源码做语法检查，再运行六个测试文件：

| 文件 | 覆盖内容 |
|------|----------|
| `test/absorbed.test.mjs` | 五项吸收能力的回归测试，断言针对 `src/` 下的**真实导出实现**（不在测试内重复逻辑）：结构化 JSON 裁决协议、判定输入脱敏、按会话的判定失败计数、确定性硬拒两档、动态系统提示上下文（仅预设激活时注入）。用临时 `DSH_HOME` 隔离，绝不触碰真实 `~/.dsh/auto-approve` |
| `test/pipeline.test.mjs` | 判定管道端到端测试，用**模拟宿主**真正执行注册的 `approval/request` 处理器：硬拒直接拒绝（不弹窗）→ 硬事实转人工 → 危险词 → 白名单 → 脱敏 → 结构化判定 → 硬类别（优先于 allow/deny）→ `deny`/`allow`/`ask` → 连续失败计数 → 确认制学习。断言处理器返回的裁决、是否调用了 `next()`（即是否弹窗），以及真正发给判定模型的消息内容。含 `deny + neutral` 静默拒绝与 `deny + 硬类别` 转人工的对照用例 |
| `test/reconsider.test.mjs` | 追认端点（`POST /api/auto-approve/reconsider`）的契约：硬拒档与硬风险类别一律 400 且不写规则、neutral 静默拒绝可追认（写带指纹规则 + 投递重试 + 记录 `reconsiderOf`）、事件 API 标注 `reconsidered` 并过滤追认记录、重复追认幂等、未知事件 404 |
| `test/client-render-smoke.test.mjs` | 客户端 bundle 的**真实渲染**冒烟测试（最小 React hooks 垫片 + DOM/fetch 桩）：拒绝提示条常驻且带「重新审批通过」/「查看审批记录」、硬拒档不给追认按钮、审批视图仅可追认行有按钮、打开审批 tab 标记已读、已读记录刷新后不再弹 |

`test/unit.test.mjs` 与 `test/seed-sync.test.mjs` 覆盖既有的规则匹配、配置迁移与多机规则共享。

## 上游署名

以下五项能力移植自 [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)（MIT License），
并按本插件的确认制学习管道做了适配：

1. 确定性硬拒层（路径事实 + 凭据外泄，分直接拒绝 / 转人工两档）
2. 判定输入脱敏（密钥与大块正文不出站）
3. 结构化 JSON 裁决协议（`decision` / `reason` / `category`）
4. 判定器连续失败计数（`judgeFailureLimit`）
5. 动态系统提示指导（`<auto_approve_policy>`）

这些能力的原始设计与实现版权归该项目所有。

## License

MIT

本项目是 [moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate) 的 fork，
原作者版权声明保留在 [LICENSE](../LICENSE) 中。
