# Agent Note: 面向本地 Codex CLI 的人工 `/review` 命令

Status: implemented

[English](2026-08-19-codex-reviewer-command.md) | 中文

## 问题

观察编程 agent 会话的操作者常常想要一份独立的外部审查，来复核 agent 到目前为止的产出 —— 正确性、设计、风险 —— 而不消耗被审查 agent 自己的回合，也不让被审查模型给自己的输出打分。把“审查这段对话”当作提示词发出去，会让审查落在产出这份工作的同一个模型上，还要占用它的一个回合。把准入做进某个 UI 界面，又会重复一遍命令发现与命令生命周期记录。不过审查结果仍然需要专门呈现，因为长时间运行的审查必须在浏览器请求结束后仍然可观察、可恢复。

审查本身是对外部工具的一次“给提示词然后运行”的任务。本地 Codex CLI 已经支持非交互提示词（`codex exec`），自带模型选择、推理投入（`model_reasoning_effort`）和沙箱配置，并且可以完全通过 stdin 加参数驱动：对话文本无需经过任何 shell 解释。审查运行的时间和输出都没有天然上限。如果整个运行留在浏览器 Remote 中，输入框会保持提交状态直到 Codex 退出，刷新页面还会通过该请求的信号取消进程。因此审查者需要持久化生命周期、Agent 持有的取消来源、进程树拆除和输出上限。

## 决策

### `/review` 是宿主平面上一条走子进程接缝的命令

`@deepseek-ai/dsh-command-reviewer` 通过 `ctx.commands` 注册全局人工命令 `/review`（审查者），并依赖 `ctx.subprocess`。处理器把接收会话的推导消息投影成纯文本对话记录（`renderTranscript`：用户/助手文本、工具调用、工具结果；推理块与图片块被跳过），组装审查提示词，然后启动一次非交互运行：

```text
codex exec --json --color never --ephemeral --skip-git-repo-check -s <sandbox> [-m <model>] -c model_reasoning_effort=<effort>
```

提示词以批量 stdin 的形式穿过子进程 seam，因此任何对话文本都不会进入 argv 或 shell 边界。在 Windows 上，argv 会包进 `cmd.exe /d /s /c`（与 `dsh-subagent-codex` 使用同一边界），因此可配置的模型值必须先验证为可移植标识符，包装层才会收到它；Codex CLI 本身必须已安装在宿主机上并完成认证。运行在会话的工作目录（会话没有工作目录时用进程目录）中执行，默认沙箱为 `read-only`。stdout 使用流式 JSONL；解码器记录公开的 Codex 阶段与安全条目摘要，并提取最终 `agent_message` 文本。

处理器每次调用都读取设置节的字段，因此设置修改实时生效。它完成可执行文件准入、写入 `review/start`、使用私有 controller 启动进程，然后立即返回带 `sourceEventSeq` 的成功确认。浏览器信号仅用于准入，不会传给已准入进程。接收 Agent 的上下文拥有 controller 与结算：正常完成会终止任何残留的后代进程，Agent 或插件卸载则中止整棵进程树；两条路径都在记录终态审查事件之前等待整棵进程树退出。

### 持久化事件负责进度与刷新恢复

纯日志生命周期为 `review/start` → 零到多个 `review/activity` → `review/end`，使用执行器生成的 `commandId` 关联。活动保留 Codex 条目身份与开始、完成状态，只投影安全类别与摘要；推理内容不会被记录。成功、结构化失败、畸形 JSONL、输出超限、非零退出、信号终止和所有者取消都通过 `review/end` 结束，而不是落成通用 Remote 中止错误。

`@deepseek-ai/dsh-client-ui-reviewer` 把这一事件族折叠为一个 Chat 节点，并渲染最终 Markdown。刷新后会重放出相同的运行中或终态；若分页只包含运行中活动或终态事件，则会先用空关注点重建卡片，直到包含 `review/start` 的分页到达。`command/done.sourceEventSeq` 指向 `review/start`；更丰富的来源存在时，通用命令 Definition 会隐藏重复行。实现不使用定时器或虚构百分比。

### `command-reviewer` 设置节承载全部可调项

插件注册 `command-reviewer` 设置命名空间（基础层 = 组合入口），schema 为：`enabled`（卡片开关；关闭时命令拒绝执行）、`model`（留空，或使用仅包含字母、数字、`.`、`_`、`:`、`/`、`@`、`+` 和 `-` 的可移植标识符）、`thinkingEffort`（`low|medium|high`）、`sandbox`、`prompt`（`{transcript}` 占位符标记对话记录插入位置，不含占位符时对话记录追加在末尾）、`context`（部署级场景补充）、`maxTranscriptChars`、`maxOutputBytes` 与 `terminateGraceMs`（受 Node 定时器上限约束）。`@deepseek-ai/dsh-client-ui-settings-plugins` 在设置页的“插件”区渲染「审查者」卡片。它与“终端”“Agent 循环”“网页搜索”使用相同的卡片界面，包括启用开关、思考程度与沙箱的下拉框、提示词与上下文的文本域。部署未组合该插件时，卡片不渲染任何内容。

### 命令完全不进入被审查 agent 的模型流

审查是一次辅助进程，不是宿主编排内的 LLM 请求。命令事件对与所有 `review/*` 事件都保持纯日志：构建出的提示词、Codex 运行和审查文本都不会进入被审查 agent 的请求。被读取的会话数据只有对话记录，并且受 `maxTranscriptChars` 约束（尾部保留，附带截断说明头）。

## 备选方案

### 为什么不做成模型工具？

名为 `review` 的工具会被被审查模型自己调用，消耗它自己的回合、给自己的产出打分；用户要的是操作者面向的命令。命令形式让调用只来自人工，并且完全脱离模型面。

### 为什么不用 `codex exec review`？

内置的 review 子命令审查的是工作仓库，而不是 agent 的对话；这里的审查对象是对话记录。自建提示词路径（`codex exec` + stdin）让载荷完全由本插件控制。

### 为什么不复用 `subagent-codex` 的 app-server 提供方？

app-server 协议是一条由 subagent 能力持有的长连接 stdio 通道；一次性的审查不需要它的线程/回合机制，组合 subagent 接缝还会把审查变成一次委派而不是一条命令。普通 `codex exec` 是满足需求的最小进程边界。

### 为什么不用动态插件？

命令必须出现在随附发布的设置面里、持有持久设置、并且跨重启存活；组合挂载的静态包是“插件”设置页与插件清单唯一能理解的形式。

### 为什么不用通用后台作业？

普通作业界面会把尚未报告的所有者作业完成通知反馈给被审查 Agent。审查必须留在该模型流之外，因此审查者直接持有后台生命周期，并把清理绑定到 Agent 上下文。

## 后果

- **每次调用一次辅助 Codex 运行**：每次 `/review` 启动一个全新的非交互进程；没有会话复用，也无法从命令内部继续审查。
- **只审查对话文本**：推理块、图片和附件不会转发；审查看到的是文本、工具调用与工具结果。
- **Codex 可用性由宿主机负责**：缺失 CLI 会阻止准入；认证、JSONL、退出码、信号与输出上限失败会在持久化卡片中可见地结束。
- **新增卡片界面**：“插件”页多出第四张卡片；`maxTranscriptChars`/`maxOutputBytes`/`terminateGraceMs` 通过 cordis.yml 而不是卡片配置，与其他宿主平面设置节保持一致。
