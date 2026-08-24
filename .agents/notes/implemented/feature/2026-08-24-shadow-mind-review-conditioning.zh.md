# Agent Note: Shadow Mind 审查条件机制

Status: implemented

[English](2026-08-24-shadow-mind-review-conditioning.md) | 中文

## 问题

全新 Shadow child 会收到 root 日志的有界投影，但三个执行细节决定该投影是否持续有用。即使 compaction 已替换较早的模型可见历史，完整历史投影仍会增长到 prompt 上限。普通 child 组合可能注入与狭窄审查无关的 runtime context 与 pre-step 增量。首次请求即存在工具目录，会让 child 在先说明准备调查哪些持久断言之前，就尝试提交终态结构化结果。

这些是条件问题，而不是新的 reviewer 身份或调度规则。它们必须使用现有一次性 subagent seam，保留策略强制执行与全新 child 可复现性，并在提供方不支持时明确拒绝，不能静默降级。

## 决策

每个 Shadow 定义有三个保持原行为默认值的条件字段：`capture: 'full' | 'since-compaction'` 默认为 `full`，`context: 'standard' | 'minimal'` 默认为 `standard`，`thinkFirst: boolean` 默认为 `false`。注册表、创作 API、管理工具、Remote 管理、浏览器表单、序列化与状态诊断使用相同词汇。

运行时还会记录 `deliberationChars`，即 child 在调用 structured-output 工具前输出的文本与 reasoning 字符。该指标只是进程内诊断数据，绝不决定准入、调度、提升或预算。

## Compaction-epoch 截获

`projectTrajectory(events, capturedThroughSeq, disclosure, capture)` 只渲染不高于截获水位的持久事件。在 `since-compaction` 模式下，它找到该范围内最近的 `compaction/end`，排除该边界及之前的普通事件，同时保留 `compaction/summary` 事件。没有边界时，输出与 `full` 完全相同。

投影输出的每一行都以来源事件 sequence 开头。报告 `refs` 根据该投影实际包含的 sequence 集合验证，而不是只与截获水位比较。Prompt 大小验证仍作用于完整封装 prompt，并以失败代替截断事件。

## Minimal child context

一次性 subagent 请求增加 `contextInheritance?: 'standard' | 'none'`，并与 `SubagentCapabilities.contextInheritance` 配对。所选提供方没有声明支持时，服务会拒绝非标准请求。Shadow Mind 把 `context: minimal` 映射为 `contextInheritance: 'none'`。

进程内 driver 在 child 组合期间应用该策略。它认领调用方初始 prompt 批次，并为该 child 抑制其他模型可见的动态上下文与 pre-step 增量。Sandbox 策略、批准策略、委派范围、生命周期观察器、持久化与其他非模型强制机制仍会安装。该选项不是 sandbox 模式，本身不会减少 filesystem 访问。

## Think-first 执行

一次性请求增加 `thinkFirst?: boolean`，并与 `SubagentCapabilities.thinkFirst` 配对。不支持的提供方会在 start 前拒绝该选项。Spawn 进程内组合支持它；fork 仅在能够保留相同语义的位置公开该能力。

Think-first 开启时，child 首次模型请求的有效工具限制为空。封装 prompt 要求给出带编号的计划，列出准备 challenge 或验证的渲染 sequence anchor。第一条持久 assistant 消息产生后，提供方恰好 steer 一次 continuation，打开已配置工具目录，并要求 child 调查后提交结构化 verdict。两步共享一个 `SubagentRun`、取消信号、截止时间、结果与 dispose 等待点。

第一次响应不会作为 Shadow 结果准入。缺少首次输出、取消、失败或 dispose 会阻止 continuation，或通过普通 stop reason 结算运行。第二步仍受 structured-output schema 以及标准 Shadow 的相同只读工具与策略限制。

## 考虑过的替代方案

**截断最早渲染字符。** 不采用，因为任意截断可能切开事件、移除后续行所依赖的断言，并使 anchor 含糊。Compaction 已提供显式语义边界。

**按来源 denylist 移除注入。** 不采用，因为新的上下文贡献者会绕过它。Child 作用域继承策略作用于统一的模型可见注入路径，同时保留强制策略插件。

**在 Shadow Mind 中构造并驱动私有 child Agent。** 不采用，因为 subagent 提供方已经拥有发布、血缘、组合、取消、结构化输出与 dispose。两个能力属于该 seam。

**只隐藏工具描述但允许执行。** 不采用，因为工具可见性与执行属于同一限制。首次请求使用空的有效 allowlist，随后一次提供方拥有的 continuation 恢复所请求目录。

**要求所有定义使用 minimal context 或 think-first。** 不采用，因为部分 reviewer 需要 workspace 指令，或受益于单步请求。两者均保持显式的每定义选择。

## 验证

轨迹测试固定 full 与 compaction-epoch 投影、带编号行、summary 保留和视窗外 anchor 拒绝。Subagent 服务测试固定明确的能力拒绝。进程内继承测试证明 minimal context 移除动态模型可见增量，同时保留批准与 sandbox 强制执行。Spawn 测试证明首次请求无工具、一次 continuation 打开请求目录，且取消或 dispose 覆盖两步。运行时集成与无密钥整装快照固定封装规划指令、请求序列、deliberation 遥测与结构化终态报告。

## 后果

较长且已 compaction 的 Session 可以审查当前 epoch，而无需携带 compaction 前原始历史。狭窄 reviewer 可以避免无关动态上下文，而不改变权限。Think-first reviewer 会额外消耗一个模型步骤，先陈述预期 anchor 再使用工具，使后续发现更容易审计。

默认值保留单步完整历史行为。`since-compaction` 依赖 compaction summary 足够完整，minimal context 可能移除有用任务指令，think-first 会增加延迟与 token 成本。诊断 reasoning 长度可以被投机，没有任何控制权。提供方必须实现确切能力或拒绝请求，这以较窄的提供方兼容性换取不发生静默行为漂移。
