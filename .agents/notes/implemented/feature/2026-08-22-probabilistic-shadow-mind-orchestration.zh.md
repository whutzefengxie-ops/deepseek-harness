# Agent Note: 概率式 Shadow Mind 编排

Status: implemented

[English](2026-08-22-probabilistic-shadow-mind-orchestration.md) | 中文

## 问题

Pi Shadow Mind 会在使用工具的轮次后运行专门的后台审查者，并把有用发现返回主 agent，无需用户逐次启动审查。DeepSeek Harness 已具有实现相同行为所需的生命周期、持久化 Session 日志、subagent（子智能体）、settings、批准和 profile 组合包机制，但缺少把这些机制连接起来的可安装组合。在插件内重新实现 Pi 私有 Session 驱动器，会重复 subagent 发布、取消、策略继承、结构化输出和完全停稳的 dispose。

该功能还跨越数据披露边界。Shadow 可以使用另一个模型提供方，因此盲目复制主 transcript、隐藏推理、工具参数或原始工具输出会扩大离开 root 提供方的数据。后台工作可能比触发它的轮次存活更久，因此新用户意图到达后，迟到报告可能已经陈旧。Headless 进程可能在工作或报告批次仍待处理时退出。因此，实现必须明确规定截获、披露、取消、投递和关闭行为。

## 决策

Shadow Mind 作为可选插件系列，通过 profile 组合包 `@deepseek-ai/dsh-shadow-mind` 安装。该组合包会挂载只面向 root 的编排服务、独立的管理工具插件，以及位于**设置 → 插件 → Shadow Mind**的 Web 管理界面。它观察现有 Session 与 Agent 扩展点；`dsh-agent-loop` 保持不变。

一个已完成 root 轮次包含至少一个持久化 `tool/result` 后，运行时执行一次 heartbeat。随后，每个已启用且模型匹配的定义分别执行自身激活抽样。命中数超过每 root 可用 slot 时，Fisher–Yates 抽样会选出无偏子集；否则运行时保持目录顺序且不消耗选择抽样。每个被选中的定义启动全新的一次性 `spawn` subagent，接收截获 root 日志的有界、无推理投影，并且必须以结构化状态结束。已接受的报告会批处理，并作为持久化用户角色消息追加到 root。

## Pi Shadow Mind 参考行为

参考 ZIP 包含 `pi-shadow-mind` 版本 `0.1.14`。它只评估包含工具结果的主 agent `turn_end`。默认 heartbeat 为 `1/3`，每个 Shadow 默认激活概率为 `0.3`，最多并行运行 2 个 Shadow。符合条件的定义独立抽样；命中数过多时使用 Fisher–Yates 选择。模型过滤接受 `*` 或精确的完整 `provider/model` 字符串。

Pi 每次运行都创建全新 Session。`debug: false` 使用内存 Session；`debug: true` 写入 Session 日志。Child 继承主 system prompt，并接收移除 assistant thinking 的序列化轨迹。默认工具为 `read`、`grep`、`find` 和 `ls`，再加 `report_to_main`。Pi 保留工具参数。已知文件工具会汇总行数和首行预览；未知工具不公开文本预览。无关审查者输出精确 `NOT_RELEVANT` sentinel；可执行审查者调用 `report_to_main`，并由此终止运行。

Pi 支持每 Shadow 模型、thinking level、超时、debug、定义与配置工具、`/shadow`、`Alt+S`、状态面板和消息 renderer。变更型管理操作要求 UI 确认。新用户输入、暂停或 shutdown 会取消活动运行并丢弃待处理报告。Print/JSON headless shutdown 会等待活动运行、报告批次、消息投递和主 agent 空闲状态。

## 定义与 settings

全局定义位于 `$DSH_HOME/shadow-minds/*.md`。YAML frontmatter 负责 `id`、`name`、`enabled`、`debug`、`activation_probability`、`active_for_models`、`run_with_model`、`reasoning_effort`、`timeout_seconds` 和 `tools`；Markdown 正文是审查职责。DSH 使用 `reasoning_effort`，因为模型适配器已经公开该选择。未知字段以及冲突或格式错误的值会失败，而不会被隐式适配。

注册表按确定性路径顺序加载文件，并隔离每个读取、YAML、验证和重复 id 失败。第一个有效定义赢得 id。创建与更新会先验证，再以仅 owner 模式原子写入，并按 id 串行执行；不同 id 的定义可以并发变更。删除会保留定义的 opt-in JSONL 调试日志。调试记录包含固定的运行身份、截获、结束、状态和错误事实，不含轨迹内容。

实时 `shadow-mind` settings namespace 负责 heartbeat 概率、每 root 并发、默认超时、headless drain 超时、批处理窗口、可选默认模型与 reasoning effort、参数披露、确定性随机种子、完整 prompt 上限和报告上限。无效 `provider/model` 默认值会在 schema 验证时失败。定义保持为具名 Markdown 实体，而不是 settings 数组，因为它们需要文件局部诊断、可审查职责和独立原子写入。

## 调度、截获与取消

系统只观察没有 `parentSession` 的 Session，因此 Shadow child 和所有其他后代都无法递归触发该运行时。每个 Shadow id 在一个 root 下最多同时运行一次。不同 root 分别拥有独立 epoch、活动 map、slot 限制、报告 batcher 和 maintenance 状态。

截获水位是触发 `turn/end` 的序号。投影包含用户文本、可见 assistant 文本、工具名称、策略选定参数、确定性工具结果元数据、compaction（压缩）摘要和更早的持久化 Shadow relay。它排除 assistant 推理、流式分片、原始工具结果文本、无关诊断和后续事件。默认参数策略为 `redacted`。已知 `read`、`grep` 和 `glob` 结果公开计数与字符数，但不公开预览；未知工具只公开成功或失败、内容类型和有界大小。完整封装 prompt 超过 `maxPromptChars` 时会关闭式失败，而不是裁切任意事件。

新的真实用户输入、用户取消、暂停、root dispose、插件 dispose 和 headless drain 超时会推进 root epoch，并中止所有活动运行。只有捕获 epoch 仍匹配、同一 root 仍在注册表中且调度仍活动时，结果才会被接受。即使取消在结算竞争中落败，这也会拒绝迟到结果。容量会一直占用到 `run.result` 与 `run.dispose()` 都结算完成。

## Child 执行与模型选择

运行时以 root 为 parent，携带 `maxDepth: 1`、每次运行的 signal、prompt、allowlist、结构化输出和可选模型选择调用 `ctx.subagents.start('spawn', request)`。默认 allowlist 为 `read`、`grep` 和 `glob`；定义工具会增加显式能力，且不会被推定为只读。工具限制会移除被拒绝的 schema，并拒绝相应执行。

进程内委派继承 parent 的显式 sandbox 覆盖，并在已组合 approval 时追加固定为 `never` 的 `approval/policy` 事件。Shadow 无法请求扩大权限。增加写入型工具仍允许修改继承 sandbox 已允许的内容，并且并行写入者没有跨 agent 事务。

一次性 subagent 启动约定携带可选的完整 `modelSelection`，而 `SubagentCapabilities.modelSelection` 声明提供方支持。服务使用 `CONFLICTING_MODEL_SELECTION` 拒绝不支持的选择以及与 `agentOptions` 冲突的选择。进程内 spawn 与 fork 提供方会在 child 创建时安装提供方、模型和 reasoning effort。该扩展使 Shadow 编排继续使用现有提供方生命周期，而不是直接构造和驱动 Agent。

对象根输出 schema 携带 `status: 'not_relevant' | 'silent' | 'report'` 和 `content: string`。Child 作用域的 `structured_output` 工具会验证 JSON schema 并结束轮次；运行时还会强制 report 非空，其他状态使用空字符串。报告文本会去除首尾空白并受上限约束。缺失或无效的结构化输出、非完成结束原因、超时、提供方失败和 dispose 失败会产生诊断，但绝不把部分 assistant 文本注入 root。

## 持久化报告投递与关闭

已接受的报告进入有序固定窗口批次。投递会重新检查 root 身份和 epoch，然后创建来源为 `{ kind: 'shadow-report', form: 'relay' }` 的 `user/message`。来源信息按章节对应每个 Shadow id、run id、child Session id 和截获水位。运行中的 root 通过 `steer()` 在下一个安全 step 边界接收消息；空闲 root 通过 `followup()` 接收。普通 inbox 负责并发顺序，而持久化消息使后续模型请求可由 Session 日志重建。

报告 batcher 公开完全停稳等待点，并为该等待点保留异步投递失败，而不是吞掉错误。Root dispose 与插件 dispose 为每个 owner 共享同一个释放 Promise。释放会等待调度、运行结果、child dispose、批次 flush 和投递；独立清理失败会聚合，并且每种结果都会移除 owner 记录。

存在 `headlessStartup` 时，仍有已准入 Shadow 工作的空闲 root 会调用 `Agent.runMaintenance()`。Maintenance 会占用 runner，直到调度、child、批次、relay 和由此产生的 follow-up 全部收敛。超时会中止工作，但仍等待完全停稳。Web 组合不会占用该区间。

## 管理与 package 拓扑

`packages/shadow-mind/shadow-mind-runtime` 提供 `@deepseek-ai/dsh-shadow-mind-runtime`、`ctx.shadowMind`、定义持久化、settings、调度、投影、child 所有权、批处理、`/shadow` 状态方法、受信任的管理 Remote 和持久化报告 invariant。`packages/shadow-mind/tool-shadow-mind` 提供 `@deepseek-ai/dsh-tool-shadow-mind`，注册 `/shadow status|pause|resume|toggle`，并贡献 8 个模型工具，用于列出、创建、更新、启用、禁用、删除、读取 settings 和更新 settings。变更要求精确的 `allowed-once` 批准结果。分离这些包允许部署只使用运行时，而不授予模型编辑权限。

`packages/client/ui-shadow-mind` 提供 `@deepseek-ai/dsh-client-ui-shadow-mind`。它会挂载生成的 Remote contribution、编辑实时 settings namespace 与 Markdown 定义、控制当前所选 root、在活动工作结束后显示进程内最近运行证据、在会话中展示已接受报告及其 root follow-up，并把 `/shadow` 结果转换为 composer 提示，使结果在空白 Session 中仍然可见。`packages/bundle/shadow-mind` 提供可安装的 `@deepseek-ai/dsh-shadow-mind` patch 层。`dsh plugin --profile <profile> add @deepseek-ai/dsh-shadow-mind` 会在所选 profile 中记录依赖和组合包；patch 会依次挂载运行时、管理工具和 Web 管理界面。

## 与 Pi 的差异

DSH 有意使用现有 `read`、`grep` 和 `glob` 工具，而不是 Pi 的 `read`、`grep`、`find` 和 `ls`。参数默认脱敏，任何已知或未知工具结果都不包含首行预览。结构化终态输出取代 `NOT_RELEVANT` sentinel 和 `report_to_main`。模型资格允许本地 `*` 与 `?` glob 对模型 id 或完整路由匹配，比 Pi 的精确完整路由规则更宽。Child Session 遵循 DSH 持久化策略，而不是在 debug 为 false 时切换到内存。DSH 通过插件设置区域提供 settings 与定义管理，在会话中展示带 child 来源的持久化报告批次，并标记消费报告的 root 回复。它保留通用 approval 与 command 展示，不增加 Pi 的 `Alt+S` 快捷键。

## 考虑过的替代方案

**把 heartbeat 调度放入 `agent-loop`。** 不采用，因为概率、专长定义、披露和批处理是可选产品策略，现有 Session 与 Agent 事件已经能够完整表达。

**复用可继续 subagent 作为持久 Shadow 记忆。** 不采用，因为每次激活都必须能由显式截获独立复现；隐藏 child 历史会跨 epoch、消耗上下文，并把取消转化为 Session 生命周期管理。

**使用可继续 child 的 `report` 工具。** 不采用，因为该工具支持重复的非终态回传和直接 continuation parent 语义，而 Shadow 只产生一个终态结构化结果。

**直接创建和驱动 child Agent。** 不采用，因为 spawn 提供方已经负责发布、血缘、委派策略、工具限制、模型选择、结构化输出、取消、结果规范化和完全停稳的 dispose。

**把定义存入一个 settings 数组。** 不采用，因为独立 Markdown 职责需要每文件诊断、稳定名称、原子写入和无需重写无关 settings 文档的审查。

**只把报告作为瞬态 UI 通知投递。** 不采用，因为报告内容会影响后续 root 请求，并且必须在 Web 与 headless 组合中都能从持久化 Session 日志重建。

## 验证

纯测试覆盖定义解析与原子变更、settings 验证、模型 glob、heartbeat 与无偏 slot 选择、确定性随机种子、轨迹披露、compaction 摘要、prompt 上限、固定窗口批处理、投递失败和报告来源。真实 AgentLoop 与进程内 spawn 覆盖证明：使用工具的 root 轮次会启动全新 child，应用所选模型和委派的 `never` 批准，捕获结构化输出，持久化 root relay，驱动 follow-up 响应，并隐藏原始参数与工具结果。取消覆盖证明新用户意图会中止活动工作并阻止陈旧 relay。并发 root 与插件 dispose 覆盖锁定共享的完全停稳释放。

管理包覆盖证明 Loader 兼容的命名导出、8 个工具和命令注册、HMR dispose、拒绝时无变更，以及 `allowed-once` 后创建、更新、启用、禁用、删除和 settings 写入。浏览器覆盖锁定 Remote 挂载与 dispose、settings 与定义管理、当前 root 控制、空白 Session 的 `/shadow` 提示、持久化报告卡片、child 来源以及 root 回复标记。组合包测试通过真实 Loader 解析已交付 `cordis.patch.yml` 并激活全部三个配置项。无密钥整装快照锁定完整 root 工具轮次、child 报告、持久化 relay、follow-up 和 headless 收敛 transcript。

## 后果

概率式审查会增加有条件模型请求、报告 token、child Session 存储，以及工具轮次后的潜在延迟。Heartbeat、独立激活、模型过滤、每 root slot、超时、prompt 与报告上限、暂停、批处理和确定性种子可以限制或复现成本，但无法消除成本。

默认披露比 Pi 更严格，可能减少审查上下文。管理员可以选择完整参数或额外工具，同时接受提供方披露和共享 workspace 竞争后果。全新 child 避免陈旧隐藏状态和递归调度，但会重复发送 prompt 上下文。持久化 relay 与 child Session 提高 replay 和可审计性，但会增加存储。Web 管理与会话卡片使配置、当前 root 状态、已接受报告及其 root follow-up 可见，同时不改变 headless 组合；缺少 `Alt+S` 仍是与 Pi 的明确差异。
