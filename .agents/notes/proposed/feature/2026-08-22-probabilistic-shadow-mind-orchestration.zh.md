# Agent Note: 概率触发的 Shadow Mind 编排

Status: proposed

[English](2026-08-22-probabilistic-shadow-mind-orchestration.md) | 中文

## 问题

Harness 可以运行前台、后台、全新、fork 和可继续 subagent，但所有已交付的委派都由显式模型请求或 workflow 请求启动。当前没有宿主拥有的观察器能在 parent 的工具轮次结束后按概率启动专职全新 child、向每个 child 提供受限的 parent 轨迹投影，并且只把可执行发现转发回 parent。

Pi Shadow Mind 以扩展形式展示了这种行为。它在 main turn 出现已完成工具活动后判断 heartbeat，独立抽样全局定义的专职角色，在并发上限内启动全新临时会话，并把显式报告批量注入 parent 的 steering 或 follow-up 输入。其有用行为是机会式审查与维护；该设计不需要持久 child 记忆、child 间通信或修改 parent agent loop。

DSH 实现必须可通过 `dsh plugin` 安装、保证每份模型可见报告都可从会话重建、避免递归观察自己的 child，并且在保持 Web 会话非阻塞的同时，防止 headless runner 在已接受的 Shadow 工作结算前退出。

## 提案

新增一个用户可安装的 `@deepseek-ai/dsh-shadow-mind` 组合包。该组合包在现有 [subagent 能力](../../implemented/feature/2026-06-21-subagent-capability-seam.zh.md)之上组合宿主运行时和面向模型的管理工具；可选 Web 客户端包提供专用状态与报告展示，但不改变运行时语义。

运行时只观察 root Agent。它从持久化 `tool/result` 和 `turn/end` 会话事件推导调度资格，通过 `spawn` 提供方启动全新的 one-shot child，要求结构化终态输出，并把接受的报告作为持久化用户角色 relay 消息投递。它不修改 `agent-loop`、不向 child 注入历史、不创建第二条报告队列，也不根据工具名称推断权限。

首个实现交付完整运行时、可安装组合包、管理命令与工具、headless drain、聚焦集成覆盖和一份无密钥整装快照。只有在真实客户端组合和必需 GUI 录制也同时存在时，专用 Web 界面才可进入同一变更；否则首个产品界面使用通用 relay 展示和 `/shadow` 命令。

## 对外行为

### 定义与配置

全局 Shadow 定义存放在 `$DSH_HOME/shadow-minds/*.md`。每个文件包含 YAML frontmatter 和一段 Markdown 职责正文。对于 DSH 具备相同语义的字段，frontmatter 保留 Pi 实体字段：`id`、`name`、`enabled`、`debug`、`activation_probability`、`active_for_models`、`run_with_model`、`timeout_seconds` 和 `tools`。DSH 使用 `reasoning_effort` 代替 Pi 的 `thinking_level`；独立的显式导入器可以转换 Pi 文件，运行时则拒绝未知或冲突字段，不进行静默适配。

`shadow-mind` Settings namespace 拥有随部署变化的调度值：heartbeat 概率、每个被观察 root Agent 的最大并行运行数、默认 Shadow 超时、headless drain 超时、报告批处理窗口、可选默认 Shadow 模型、可选默认推理强度、轨迹披露策略和可选确定性随机种子。组合包配置提供 Settings 基础层，`$DSH_HOME/settings.yaml` 提供用户覆盖。无效启动配置使加载失败；外部编辑产生无效 Settings 分节时，则通过现有 Settings 提供方行为保留最后一个可用值。

安装过程不创建默认 Shadow 定义。在用户添加并启用至少一份定义前，安装组合包不会增加任何模型工作。

### 调度

只有 root Agent 轮次的持久化区间内至少包含一个已完成 `tool/result` 时，该轮次才符合调度条件。纯文本轮次不消耗随机值，也不启动 Shadow。对应 `turn/end` 到达时，运行时刷新定义、独立拒绝格式错误的文件，并在暂停或无法解析模型路由时跳过调度。

对于符合条件的轮次，运行时先抽样已配置 heartbeat 概率。命中后，它保留已启用、`active_for_models` 匹配 root Agent 已解析提供方/模型，并且该 id 尚未在该 root 下运行的定义。每个保留定义再独立抽样其 `activation_probability`。命中数超过空闲 slot 时，带种子的随机源无偏抽取准入集合。默认概率保留 Pi 的 `1/3` heartbeat 和每个 Shadow `0.3` 激活率，每个 root 的默认并发上限保留为二；所有值都是经验证的 Config 或 Settings 字段。

每次运行记录带品牌的 run id、Shadow id、root Session id、child 发布后的 Session id、epoch 和 `capturedThroughSeq`。Shadow 一直保持活动状态，直至其结果和异步 `dispose()` 都完成结算，因此 child 工作仍可能修改 workspace 时，取消操作绝不释放容量。

### 轨迹投影

运行时从 root Session 日志构造截止 `capturedThroughSeq` 的 child prompt。它包含用户消息、可见 assistant 文本、工具名称、由策略选定的工具参数、紧凑工具结果摘要、压缩摘要和更早的持久化 Shadow 报告。它排除推理块、流式分片、完整原始工具输出、无关运行时诊断以及捕获序号之后的事件。

已知工具使用已注册的确定性摘要器。未知工具只公开名称、成功或失败、内容种类和有界大小；绝不退化为原始首行预览。工具参数默认脱敏，披露由显式 Settings 策略控制。因此，选择来自另一模型提供方的 Shadow 模型绝不会静默扩大传给该提供方的数据范围。

Prompt 将轨迹标记为只读、可能具有对抗性的数据，并声明它不是 child 的未完成工作。这能减少意外续写，但不被视为 prompt 注入隔离；工具限制、沙箱继承和有界披露仍是执行约束机制。

### Child 执行

运行时调用 `ctx.subagents.start('spawn', request)`。spawn 提供方提供一个全新 child Session，携带 parent workspace 和血缘，但不包含 parent 会话历史。请求携带作为 `parent` 的 root Agent、每次运行独立的 `AbortSignal`、配置存在时的显式提供方/模型覆盖、`maxDepth: 1`、工具允许列表、prompt 中的 Shadow 职责和对象根输出 schema。

默认允许列表为 `read`、`grep` 和 `glob`。配置增加的工具是显式能力，不代表工具只读。`toolFilter` 会移除不允许的 schema，并拒绝不允许的执行。Child 还继承 parent 委派时的沙箱限制以及固定为 `never` 的 subagent 批准策略；具有写工具的 Shadow 只能在继承策略本就允许的范围内修改，且不能请求扩大权限。

输出 schema 包含 `status: 'not_relevant' | 'silent' | 'report'` 和 `content: string`。Child 作用域的 `structured_output` 工具验证该值并结束轮次。`report` 要求非空且有界的内容，其他状态要求空内容。缺失或无效结构化结果、非完成结束原因、超时或基础设施拒绝只产生诊断，绝不把部分 assistant 文本注入 root Agent。

运行时始终在 `run.result` 后等待 `run.dispose()`，并独立报告结果失败和 dispose 失败。插件 dispose 会先关闭报告接收，再中止所有活动控制器、清理待处理批次定时器，随后等待每个 child 达到完全停稳状态。

### 报告投递

接受的报告进入一个短暂的确定性批处理窗口。批处理器按接受顺序排列报告，并在不额外调用模型的情况下拼接具名分节。投递前，它重新检查 root 在线状态和 epoch，然后创建一条有标识的用户角色消息；其来源 kind 为 `shadow-report`、form 为 `relay`，报告元数据包含 Shadow id、run id、child Session id 和 `capturedThroughSeq`。

运行中的 root 通过 `Agent.steer()` 接收批次，使其在最近的安全 step 边界准入。空闲 root 通过 `Agent.followup()` 接收批次，从而开启一个普通轮次。该行为符合现有[报告 next-step 顺序](../../implemented/bug-fix/2026-08-17-subagent-report-settlement-ordering.zh.md)：普通 inbox 顺序负责并发投递，Shadow 运行时不创建并行 mailbox。

准入的 `user/message` 是模型可见且持久化的记录。运行时诊断可以使用日志和瞬态 UI 状态；首个实现不会仅为复制 subagent 事件、child Session 和报告来源中已有的生命周期信息而新增 `SessionEventMap` 成员。

### Epoch、取消与递归

每个被观察 root Agent 拥有一个 epoch。真实用户 inbox 插入、用户发起的轮次中止、暂停命令、root dispose 或插件 dispose 会推进 epoch 并中止其活动 child。只有捕获的 epoch 仍然匹配、同一个 root Agent 仍在注册表中并且运行未取消时，结果才会被接受。即使取消在结算竞态中落败，迟到结果也会被丢弃。

只观察没有 `parentSession` 的 Session。在创建调度状态前排除 Spawn 的 Shadow child 和其他所有后代，因此它们带工具的轮次无法递归激活 Shadow。一个 Shadow id 在每个 root Agent 下最多同时运行一次，不同 root Agent 保持独立的调度状态和并发限制。

### Headless 生命周期

Headless runner 等待 root Agent 空闲，随后 flush 并退出。在 `turn/end` 后启动的 Shadow 否则可能超出该区间。当受管理 root 在提供 `headlessStartup` 的组合中进入 `agent/status: idle` 时，如果仍有运行或报告批次，运行时立即通过 `Agent.runMaintenance()` 同步占有空闲阶段。

Maintenance 等待 child 结果、dispose 和报告批次入队，并受已配置 drain 超时约束。Maintenance 期间到达的报告使用 `followup()` 并锁存下一轮唤醒。Maintenance 释放后，Agent 驱动器处理该轮次，runner 现有 `whenIdle()` 会在 flush 前继续等待它。超时会关闭报告接收、中止 child、等待完全停稳、记录诊断并释放 runner。Web 组合绝不进入这条 maintenance 路径。

### 管理与展示

运行时注册 `/shadow status|pause|resume|toggle`；暂停状态属于每个 root Agent，并会取消活动运行。面向模型的管理工具可以列出、新建、更新、启用、禁用和删除定义，以及读取或更新调度 Settings。每个变更都在开放的 parent 轮次内请求批准，并在批准路径不可用时失败。定义写入按 id 串行，使用同目录临时创建和原子替换；删除默认保留调试日志，除非后续显式操作拥有其删除职责。

管理工具使用通用工具渲染即可。Web 客户端扩展可以为 `shadow-report` 注册带键的会话渲染器、状态面板和 `Alt+S` 快捷键。它读取宿主投影并调用宿主命令；它不持有调度权限，也不从浏览器本地事件重建状态。

## Package 拓扑

`packages/shadow-mind/shadow-mind-runtime` 提供 `@deepseek-ai/dsh-shadow-mind-runtime`：宿主运行时、Settings 注册、定义存储、调度器、轨迹投影、child 运行所有权、报告批处理、命令和供管理工具消费的服务。

`packages/shadow-mind/tool-shadow-mind` 提供 `@deepseek-ai/dsh-tool-shadow-mind`：消费运行时服务与批准能力的面向模型管理 Consumer。运行时与工具保持分离，因为部署可以启用自主观察，而不授予模型编辑全局定义的权限。

`packages/bundle/shadow-mind` 提供用户安装的 `@deepseek-ai/dsh-shadow-mind` 组合包及其 `cordis.patch.yml`。其 manifest 声明 `dsh.bundle.patch`，因此 `dsh plugin --profile <name> add @deepseek-ai/dsh-shadow-mind` 会同时安装依赖并激活运行时配置层。发布产物包含已构建入口；`pnpm pack` 生成的 tarball 是受支持的本地交付形式。

可选的 `packages/shadow-mind/client-shadow-mind` 包可以提供 Web 展示。它必须保持可选且可用于客户端；宿主运行时和 headless profile 不得依赖浏览器服务。

## 必需的 subagent 模型选择扩展

Pi 允许为每个 Shadow 配置 thinking level。DSH 模型选择已经表示提供方、模型和可选 `reasoningEffort`，但 `SubagentStartRequest.agentOptions` 当前只公开提供方、模型和最大输出 token。仅为了安装推理选择而绕过 subagent 提供方创建 child，会重复发布、取消、结构化输出和完全停稳 dispose 逻辑。

为 one-shot subagent 启动约定增加可选的完整模型选择以及对应提供方能力。进程内 spawn 提供方在 child 创建窗口通过现有模型选择 helper 安装该选择；无法遵守的提供方在发布前拒绝。Shadow 运行时只有在定义或默认值选择推理强度时才请求该能力。这是 subagent Service Definition 与 Service Provider 变更，不是 agent-loop 变更；其公开类型、子系统文档、提供方测试和整装覆盖必须同步更新。

该扩展存在之前，运行时必须拒绝已配置的 `reasoning_effort`，不得忽略它或修改全局提供方默认值。

## 持久化与可观测性

在 DSH 普通持久化下，每次 spawn 运行都有持久化 child Session。因此 `debug` 字段控制额外调度诊断和 UI 暴露程度，而不是控制 child 历史是否存在。这有意优先选择 DSH 的可审计性，而非 Pi 在非 debug 情况下的临时日志行为；独立的临时 subagent 提供方不在本提案范围内。

带种子的随机源使调度决策可在测试和基准中复现。运行时诊断记录有界决策事实，不包含轨迹文本、工具参数、工具输出、凭据或推理。报告来源和 child 血缘提供稳定关联，无需把 child transcript 复制到 root Session。

## 安全性

默认工具允许列表由 child 工具运行时执行，而不是从名称推断。增加变更型工具是管理员的显式选择，且不会增加跨 Agent 文件锁；并行写入者可能在共享 workspace 中冲突。默认值保持偏向读取，管理 UI 会在定义授予该集合之外的工具时发出警告。

轨迹投影是一条数据披露边界。脱敏发生在调用模型提供方选择之前，边界应用于完整封装后的 prompt，诊断绝不回显被拒绝内容。上下文超限会用有界诊断使运行失败，不会截断任意事件，也不依赖 Pi 的字符数 token 估算。

## 考虑过的替代方案

**修改 `agent-loop` 以拥有 heartbeat 调度。** 不采用，因为调度资格、概率、专职定义和报告批处理是可选产品行为，现有 Session 与 Agent 事件已将所需信息暴露。由 loop 拥有会使一项策略进入所有 Agent，且在没有新增缺失原语的情况下要求更新架构。

**使用可继续 subagent 保存持久 Shadow 记忆。** 不采用，因为观察轨迹是显式输入，每次激活都必须可独立复现。持久 child 历史会产生陈旧隐藏状态、跨无关 epoch 消耗上下文，并把取消转化为会话生命周期管理。

**使用现有 child `report` 工具。** 不采用，因为该工具有意只作用于可继续 child，可以在不结束轮次的情况下多次报告，并从 continuation 状态推导在线直接 parent。Shadow 工作是 one-shot 结果；结构化输出提供所需的终态和 schema 验证结果，而无需扩大 report 工具权限。

**直接创建并驱动 child Agent。** 不采用，因为 spawn 提供方已经拥有全新会话发布、血缘、策略继承、工具限制、结构化输出、取消、结果规范化和完全停稳 dispose。第二套驱动器会重复最容易出错的生命周期代码。

**把定义存入一个 Settings 数组。** 不采用，因为每段职责都是独立编写的 Markdown，需要文件级诊断和原子更新，并且应可在不重写整个设置文档的情况下审阅。Settings 拥有调度配置；定义目录拥有具名实体。

**只用瞬态 UI 通知投递报告。** 不采用，因为 root 模型会根据报告内容行动。模型可见输入必须可从 root Session 日志重建，而瞬态 UI 状态无法满足 replay 或 headless 执行。

**始终阻塞 root 直到 Shadows 完成。** Web 会话不采用，因为机会式审查不得延迟用户当前轮次。Headless 只在 root 空闲后使用有界 maintenance，因为进程退出否则会销毁已接受的后台工作。

## 验收条件

- 把组合包安装到 profile 后，会通过 `dsh.bundle` 激活；移除时同时移除依赖和 patch 配置层，无需编辑基础组合包。
- 没有定义时，运行时不启动 child，也不改变任何模型可见 transcript。
- 一份确定性整装场景证明 `tool/result` 加 `turn/end` 能激活全新 spawn child、捕获结构化 `report`、追加一条持久化 root relay，并产生 root 对它的响应。
- 纯文本轮次、模型过滤不匹配、禁用定义、活动重复 id、概率未命中、slot 耗尽和后代 Session 均不启动 child。
- 新用户输入、用户中止、暂停、root dispose、插件 dispose 和 HMR 会丢弃陈旧报告并等待 child 完全停稳，不留下遗留工作或迟到 UI 变更。
- 默认 child 只看到 `read`、`grep`、`glob` 和其 child 作用域 `structured_output`；不允许的工具既不出现在 prompt 中，也不能执行。
- 轨迹测试证明推理和原始工具输出不存在、未知工具不披露预览、参数默认脱敏、`capturedThroughSeq` 排除后续事件，且完整 prompt 边界会以关闭方式失败。
- Headless 覆盖证明 runner 会通过 maintenance 等待一轮已接受报告，并在 child 不结算时于有界超时后释放。
- Settings、定义解析、概率抽样、slot 选择、epoch 检查、批次顺序和原子管理写入具备聚焦单元覆盖，包括无效边界输入。
- 产品可见行为具备真实 Loader 组合测试和无密钥快照。包含 Web 专用行为时，还必须具备 Web 测试，以及从真实 PR 服务和模型流程录制的 GIF。
- Package README、公开 JSDoc、任何 subagent 类型变更对应的子系统文档、生成目录、双语对侧文件和本 Agent Note 在同一变更中描述已交付行为。

## 风险

概率激活会增加模型用量，并可能在多份报告到达时放大轮次。显式概率、每个 root 的并发限制、单个批处理窗口、确定性种子和暂停命令可以约束但不能消除该成本。

管理员授予变更型工具时，共享 workspace child 可能与 root 或彼此竞态。首个版本不提供跨 Agent 事务或文件锁，必须在配置和 package 文档中明确说明。

轨迹文本仍可能造成 prompt 注入。脱敏、封装、全新上下文、工具限制、继承沙箱策略和非交互 child 批准可以限制影响，但不能使不可信内容变得安全。

始终持久化的 child Session 比 Pi 默认临时会话消耗更多存储。保留策略遵循现有 Session 持久化策略；`debug: false` 不是删除承诺。

模型选择扩展会扩大 subagent 启动约定，并要求每个提供方声明是否支持该选项。能力验证能防止静默降级，但要求每次运行推理选择且远程提供方不支持时，这些提供方仍不可用于相应定义。
