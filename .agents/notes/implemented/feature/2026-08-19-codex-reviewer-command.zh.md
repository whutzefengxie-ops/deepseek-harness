# Agent Note: 面向本地 Codex CLI 的人工 `/review` 命令

Status: implemented

[English](2026-08-19-codex-reviewer-command.md) | 中文

## 问题

观察编程 agent 会话的操作者常常想要一份独立的外部审查，来复核 agent 到目前为止的产出 —— 正确性、设计、风险 —— 而不消耗被审查 agent 自己的回合，也不让被审查模型给自己的输出打分。把“审查这段对话”当作提示词发出去，会让审查落在产出这份工作的同一个模型上，还要占用它的一个回合。把准入做进某个 UI 界面，又会重复一遍命令发现与命令生命周期记录。不过审查结果仍然需要专门呈现，因为长时间运行的审查必须在浏览器请求结束后仍然可观察、可恢复。

审查本身是对外部工具的一次“给提示词然后运行”的任务。本地 Codex CLI 已经支持非交互提示词（`codex exec`），自带模型选择、推理投入（`model_reasoning_effort`）和沙箱配置，并且可以完全通过 stdin 加参数驱动：对话文本无需经过任何 shell 解释。如果整个运行留在浏览器 Remote 中，输入框会保持提交状态直到 Codex 退出，刷新页面还会通过该请求的信号取消进程。辅助进程也需要明确的运行时间与输出上限。因此审查者需要持久化生命周期、Agent 持有的取消来源、进程树拆除和资源限制。

## 决策

### `/review` 是宿主平面上一条走子进程接缝的命令

`@deepseek-ai/dsh-command-reviewer` 通过 `ctx.commands` 注册全局人工命令 `/review`（审查者），并依赖 `ctx.sessions`、`ctx.sessionPersistence` 与 `ctx.subprocess`。处理器把接收会话的推导消息投影成纯文本对话记录（`renderTranscript`：对话文本、工具调用和工具结果；请求配置上下文、推理与图片被排除），增量统计 Unicode code point 并且只保留配置的尾部，组装审查提示词，然后启动一次非交互运行：

```text
codex exec --json --color never --ephemeral --skip-git-repo-check -s <sandbox> [-m <model>] -c model_reasoning_effort=<effort>
```

提示词以批量 stdin 的形式穿过子进程 seam，因此任何对话文本都不会进入 argv 或 shell 边界。每次运行都会用包含新 UUID 的分隔标识包裹对话记录，并要求 Codex 只把其中内容视为不可信审查证据，不得视为指令。投影会排除带语义标记的指令、目录和运行时快照上下文，避免把请求配置呈现为用户对话；直接消息、模型输出、工具活动、通知、转发、召回、压缩摘要和未知扩展形式仍作为证据。当前子进程提供方在自身执行环境中解析 Codex 的规范路径，并把它放进 `argv[0]`。如果该路径是 Windows `.cmd` 或 `.bat` 包装器，则通过同一提供方解析 `cmd.exe`；argv 使用 `/d /q /v:off /s /c` 展开 `DSH_CODEX_REVIEWER_EXECUTABLE`，其显式子进程环境值是加引号的规范包装器路径。因此，包含空格或命令元字符的路径仍是一个可执行文件 token。可配置模型值会在进入解释器前验证为可移植标识符。Codex CLI 本身必须安装在提供方的执行环境中并完成认证。运行在会话的工作目录（会话没有工作目录时用进程目录）中执行，默认沙箱为 `read-only`。stdout 使用流式 JSONL；解码器记录公开的 Codex 阶段与安全条目摘要，并提取最终 `agent_message` 文本。

处理器每次调用都读取设置节的字段，因此设置修改实时生效。它在解析可执行文件前原子预留一个 Agent 审查名额，并在准入失败时保留子进程提供方的诊断。该命令关闭通用输入记录；`command/run` 省略 `args`，`review/start.focus` 是成功准入后关注点的唯一持久副本。紧接在追加 `review/start` 之前，它调用命令注册表为本次 invocation 提供的 `commit()` 能力，把结算所有权从浏览器请求转移给持久化生命周期；取消仲裁与 `command/done` 始终只由注册表持有。启动记录包含实际提示词、规范 argv、显式子进程环境项、工作目录、必需的 `hostDeath: 'terminate'` 行为与运行超时。启动进程前，处理器调用 `ctx.sessions.flush(session)`，再通过 `ctx.sessionPersistence.readFrom(session.id, start.seq)` 读取存储，并要求其中事件与新 `review/start` 完全匹配；任何无关 flush listener 的参与都不能满足准入条件。启动记录写入失败或不完整都会阻止进程；只有终态事件本身能够从持久化存储读回时，才会记录失败终态并释放名额。`commit()` 前发生的浏览器中止会阻止准入，提交后发生的中止则不能把命令变成错误 `command/done`。处理器再通过 Agent 持有的 controller 和 deadline 启动进程，并立即返回带 `sourceEventSeq` 的成功确认。如果 spawn 同步触发所有者卸载后再抛出异常，已中止的所有者会让终态记为 `cancelled`，而不是由启动异常把终态记为 `failed`。无法在自身宿主退出时移除进程树执行能力的提供方会在 Codex 启动前拒绝。随附的本地批量 stdin 提供方只在 Windows 准入该要求，kill-on-close Job Object 会约束后代；其 POSIX guardian 无法约束 `setsid()` 后代，因此会在启动前拒绝。默认 Web 组合因而只在 Windows 挂载审查者命令及其设置；拥有等价提供方的 POSIX 部署可以在后置 overlay 中启用该行。正常完成会终止任何残留的后代进程；超时、Agent 卸载或插件卸载会终止进程树。所有终态路径都先确认整棵进程树已经退出，再追加 `review/end`，从持久化存储精确读回该终态事件后才释放 Agent 名额。退出确认、终态追加或终态持久化失败都会让审查保持未闭合和被持有状态，记录后台失败，并让卸载过程报告该失败，而不是声称已经完全停稳。

### 持久化事件负责进度与刷新恢复

纯日志生命周期为 `review/start` → 零到多个 `review/activity` → `review/end`，使用执行器生成的 `commandId` 关联；其完整运行时实例 UUID 加单调计数器可防止重启后的命令运行时复用恢复日志中已有的标识。活动保留 Codex 条目身份与开始、完成状态，只投影安全类别与摘要；推理内容不会被记录。成功、结构化失败、畸形 JSONL、输出超限、非零退出、信号终止、超时和所有者取消都通过 `review/end` 结束，而不是落成通用 Remote 中止错误。失败终态会先保留失败前已解码出的最终审查文本，再组合所有已观察到的结构化、输出解码、运行时间、退出、信号、终止请求与进程完成诊断。收到 `agent/session-start` 时，插件会扫描每个启动记录。命令确认缺失时，恢复逻辑会先追加一条指向 `review/start` 的成功 `command/done`，即使 `review/end` 已存在；这样能在宿主停止于两次持久化结算之间后关闭通用命令投影。对于没有终态的启动记录，持久化的 `hostDeath: 'terminate'` 准入事实与启动检查点使其成为此前进程生命周期的权威：Codex 不能在持久化前开始，而此前宿主消失时，获准的提供方会移除旧进程树的执行能力。恢复逻辑随后追加一个 `interrupted` 终态。若继承的启动事件序号位于 `SessionHeader.seedLength` 内，则改为记录该运行没有在 fork 中继续，并保持源会话不变；fork 在该边界后自行追加的启动事件仍按普通宿主停止恢复。压缩仍在同一会话和所有者中进行，不会结束审查。第二次启动边沿会看到两个生命周期都已闭合，不再追加记录。

`@deepseek-ai/dsh-client-ui-reviewer` 把这一事件族折叠为一个 Chat 节点，并渲染最终 Markdown。刷新后会重放出相同的运行中或终态，宿主恢复与 fork 继承会把各自不同的记录原因显示为「已中断」；若分页只包含运行中活动或终态事件，则会先用空关注点重建卡片，直到包含 `review/start` 的分页到达。没有活动的运行中卡片会等待 Codex 事件；终态卡片会移除这条等待文案。`command/done.sourceEventSeq` 指向 `review/start`，审查节点还以同一个带品牌类型的 `CommandId` 声明呈现所有权。可见非 command 节点认领其中任一关联时，Chat 投影都会隐藏通用命令行，因此只有 update 的分页在 prepend 加载启动锚点前不会产生重复行。未安装审查卡片的部署仍保留通用结果。生命周期 invariant 会检查 `/review` 命令身份、关注点、请求字段与 `command/done` 的精确来源关系。实现不虚构百分比。

### `command-reviewer` 设置节承载全部可调项

插件注册 `command-reviewer` 设置命名空间（基础层 = 组合入口），schema 为：`enabled`（卡片开关；关闭时命令拒绝执行）、`model`（留空，或使用仅包含字母、数字、`.`、`_`、`:`、`/`、`@`、`+` 和 `-` 的可移植标识符）、`thinkingEffort`（`low|medium|high`）、`sandbox`、`prompt`（`{transcript}` 占位符标记对话记录插入位置，不含占位符时对话记录追加在末尾）、`context`（部署级场景补充）、`maxTranscriptChars`、`maxPromptBytes`、`maxOutputBytes`、`terminateGraceMs`、`timeoutMs` 与 `maxConcurrentReviews`。定时器字段受 Node 上限约束；默认运行超时为 60 分钟，同一 Agent 默认只允许一条活动审查。`maxPromptBytes` 默认为 1 MiB，在持久化或进程准入前拒绝超过上限的完整 UTF-8 提示词；`maxOutputBytes` 默认为 8 MiB，可容纳仓库检查产生的命令输出，同时仍会限制失控进程。`@deepseek-ai/dsh-client-ui-settings-plugins` 在设置页的“插件”区渲染「审查者」卡片。它与“终端”“Agent 循环”“网页搜索”使用相同的卡片界面，包括启用开关、思考程度与沙箱的下拉框、提示词与上下文的文本域。卡片会在保存前校验模型标识符，为不同字段显示对应的无效值文案，并提醒用户可写沙箱模式会把相应权限授予对话记录驱动的审查命令。部署未组合该插件时，卡片不渲染任何内容。

### 命令完全不进入被审查 agent 的模型流

审查是一次辅助进程，不是宿主编排内的 LLM 请求。命令事件对与所有 `review/*` 事件都保持纯日志：构建出的提示词、Codex 运行和审查文本都不会进入被审查 agent 的请求。被读取的会话数据只有对话记录；`maxTranscriptChars` 限制其保留尾部，`maxPromptBytes` 限制加上包装和补充段落后的完整提示词。

## 验证

组合后的 Web 生命周期测试会在原生 Windows 上通过 Chromium 提交命令并检查持久化会话日志，证明受 Job 持有的 Codex 启动、公开活动、完成与刷新重放。进程级 Web 场景会提交 `/review`、从外部强制终止构建后的宿主、证明 Job 移除假 Codex 根进程及其脱离后代、使用同一持久化根重启，并要求重复刷新后仍恰好只有一条 interrupted 终态事件与命令确认。在 POSIX 上，生命周期测试改为证明默认命令目录和设置命名空间不包含不受支持的审查者，且刷新前后都不会出现 Codex 进程或审查卡片。[Windows CI 拓扑](../process/2026-08-08-native-windows-pull-request-ci.zh.md)负责聚焦的必需原生结果与完整原生清单。

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

### 为什么不用宿主级并发限制？

`maxConcurrentReviews` 用来防止同一 Agent 内重复或过量的审查，该 Agent 同时持有对应的生命周期与清理名额。宿主级资源策略应由子进程或部署容量层负责；只统计无关 Agent 的审查者进程会让它们的命令准入彼此耦合，却不能限制其他 Codex 使用方。

## 后果

- **每次调用一次辅助 Codex 运行**：每次 `/review` 启动一个全新的非交互进程；没有会话复用，也无法从命令内部继续审查。
- **只审查对话文本**：指令、目录和运行时快照上下文、推理块、图片与附件不会转发；审查看到的是对话文本、工具调用与工具结果。
- **Codex 可用性与进程所有权由宿主机负责**：可执行文件解析失败会阻止准入，并显示子进程提供方的诊断；随附本地提供方只在 Windows 准入审查者所需的宿主死亡所有权。认证、JSONL、退出码、信号与输出上限失败会在持久化卡片中可见地结束，且不会丢弃已经解码出的最终审查文本。
- **未闭合记录按真实生命周期原因结束**：宿主尚未写入 `review/end` 就停止时，已准入审查会在该会话下次启动时变成「已中断」；fork 继承的开放审查只在子会话中以“未继续”结束。源会话与已终止的 Codex 进程都不会恢复或重写。
- **新增 Windows 卡片界面**：挂载审查者命令时，“插件”页多出第四张卡片；POSIX 默认省略它。`maxTranscriptChars`/`maxPromptBytes`/`maxOutputBytes`/`terminateGraceMs`/`timeoutMs`/`maxConcurrentReviews` 通过 cordis.yml 而不是卡片配置，与其他宿主平面设置节保持一致。
