# Agent Note: Shadow Mind 目标架构

Status: implemented

[English](2026-08-24-shadow-mind-target-architecture.md) | 中文

## 问题

已交付的[概率式 Shadow Mind 编排](2026-08-22-probabilistic-shadow-mind-orchestration.zh.md)提供全新后台 reviewer、有界轨迹投影、持久化 relay 与生命周期所有权。它本身不决定哪些轮次值得增加消耗，不为发现提供持久轨迹 anchor，也不区分独立 reviewer、解决重复或冲突发现，或限制一个 Session 内的审查成本。[审查条件机制](2026-08-24-shadow-mind-review-conditioning.zh.md)与[审查质量机制](2026-08-24-shadow-mind-review-quality-directions.zh.md)分别解决问题的不同部分，需要一份共同的所有权与组合决策。

持久“审查委员会”不是正确模型。每次 Shadow 运行都是全新无状态 child。过滤器、冷却、预算与分类属于确定性运行时状态，可选 synthesizer 只接收一个批次中选中的报告。批准策略固定为 `never` 的只读 child 可以检查持久轨迹的一致性，但不能证明已省略数据或不可访问产物的断言。

## 决策

Shadow Mind 是自管理、anchored-level 的审查流水线。确定性规则决定何时消耗；每次准入运行收到 epoch 作用域投影与显式条件；每份报告给出认识论 verdict 与可选持久事件 anchor；确定性协调处理重复、vendor 关系、预算与冲突；仅含元数据的诊断衡量 root 是否采纳 challenge。报告始终是独立分析，不获得支配 root 的权限。

该架构有五个所有权层：

1. 触发层拥有 heartbeat 探索、具名 skip 与 boost 谓词、有效概率、衰减、冷却和 Session 预算。
2. 运行层拥有 `capture`、`context`、`thinkFirst`、模型路由、工具限制、批准与 sandbox 继承，以及 deliberation 字符遥测。
3. 输出层拥有 `verdict`、`severity`、`refs`、报告验证、severity 排序与持久 relay provenance。
4. 协调层拥有停滞模式、vendor 独立性标签、单 pair 冲突综合、fail-open 行为与替换 provenance。
5. 治理层拥有软硬预算、owner 侧 holdout literal、进程内状态、仅含元数据的 debug journal 和诊断 value loop。

## Anchored 投影与报告语义

每一行渲染后的轨迹都携带持久 Session sequence。`capture: since-compaction` 选择最近 compaction epoch 并保留 summary，因此 `refs` 只能指向 reviewer 实际看到的事件。报告使用 `challenge`、`gap`、`confirm` 或 `uncertain`；`gap` 表示缺少必要证据，`uncertain` 表示可见证据不足以判断。Severity 只在一次 relay 内排序报告并打破综合 pair 的近似平局，不是跨模型质量分数。

`thinkFirst` 会在工具可见前明确要求 child 给出计划调查的渲染 sequence 编号。运行时把 structured output 之前的文本与 reasoning 字符记录为诊断 `deliberationChars`。长度容易被投机，不参与准入或调度门槛。

添加到 `shadow-report` provenance 的可选字段可忽略，且不改变 Session 日志结构。因此 `SESSION_FORMAT_VERSION` 保持为 `0`。

## 确定性消耗与协调

具名谓词无需模型调用即可检查持久事件。Skip 谓词拒绝已选运行；boost 谓词在抽样前放大激活概率。状态公开每定义有效概率。带 seed 的调度只在历史与 settings 相同时可复现，并非仅由 seed 决定。

审查窗口检测 spinning、oscillation、no-drift 与 diminishing novelty。检测会安装墙钟冷却，或在配置后先消耗更高一档 reasoning effort 再抑制。真实用户消息会重置冷却、提升、概率衰减、消耗和待处理 challenge 观察。

Prompt 与已接受报告字符按 root 累积。软上限把符合条件的运行路由到已配置节省模型；硬上限阻止新运行，但不取消已准入工作。每个阈值与路由都是经过验证的 settings 或定义数据，不是部署无法修改的插件常量。

冲突综合每批最多检查一对 refs 重叠的 `challenge`／`confirm`。有效综合会替换该 pair，继承较弱报告的 severity 与认识论地位，并记录被替换 run id。缺少配置、prompt 超限、硬预算耗尽、无效或安静输出、超时、取消、提供方失败与 dispose 失败，都会原样转发两个报告并追加仅含元数据的诊断。

## Holdout 与 value-loop 边界

Holdout key 只存在于 owner 可读的 `$DSH_HOME/shadow-minds/holdout-keys.json`，并按定义 id 分组。运行时对轨迹投影、child prompt、已接受报告、综合 prompt 与 root relay 执行字面替换。定义、Remote 响应、UI 表单、provenance 与 debug journal 从不包含 key。

该机制不是 filesystem sandbox。Child Session 遵循普通持久化策略，child 工具保留继承 sandbox 所允许的访问，模型也可能通过改写或转述绕过字面匹配。受限工具、无披露部署配置与 prompt 纪律仍是强制控制。

对每个已接受 challenge，value loop 会观察已配置数量的后续 root 轮次，并把持久证据分类为 `challenge_adopted`、`challenge_rejected` 或 `ignored`。Adoption 识别明确行动用语，或与被 challenge 事件所引用产物重叠的工具目标；rejection 要求明确反驳用语。进程内计数公开 challenge 数与命中率。仅 owner 可读写的 `value-loop.jsonl` 存储分类元数据，不含轨迹或报告文本。分类器输出绝不把关、调节、奖励或抑制运行时行为。

## 所有权

本记录拥有组合架构、五层划分、anchored-level 主张、holdout 边界、value-loop 无权威性和跨机制顺序。[条件机制记录](2026-08-24-shadow-mind-review-conditioning.zh.md)拥有 compaction 截获、minimal context、think-first 执行与 deliberation 遥测。[质量机制记录](2026-08-24-shadow-mind-review-quality-directions.zh.md)拥有 probe、谓词、envelope、停滞、独立性、综合、holdout 机制与预算。原始[编排记录](2026-08-22-probabilistic-shadow-mind-orchestration.zh.md)继续拥有基础 scheduler、全新 child 生命周期、披露投影、持久批处理、管理拓扑与 Pi 对比。

## 考虑过的替代方案

**持久 reviewer 身份或跨运行记忆。** 不采用，因为每次运行都必须能由显式截获复现；隐藏 reviewer 历史会跨越取消 epoch，并把确定性协调变成另一套 agent 生命周期。

**把结果描述为 evidence-grade。** 不采用，因为 child 无法验证已省略内容或不可访问状态。Anchored-level 表达真实保证：发现可以引用可见持久轨迹。

**把 reasoning 长度作为质量门槛。** 不采用，因为长度可以在不改进发现的情况下被优化。在另一份独立决策引入更好信号前，它只保留为遥测。

**让 challenge 分类自动调节调度。** 不采用，因为启发式较弱，可能把沉默或巧合的工具活动误分类。其代价仅限于一条诊断记录。

**不经综合直接转发冲突。** 保留为必需的 fail-open 路径，但不是唯一路径：已配置 synthesizer 可以减少仲裁工作，而在无法生成有效替代时保留两个原报告。

## 验证

纯测试固定带编号投影、compaction 视窗、谓词行为、报告 envelope 验证、全部停滞模式、vendor 标签、冲突选择与 fail-open 路径、holdout 替换、预算和固定 value-loop 回放语料。真实 AgentLoop 与 spawn-provider 测试固定 minimal context、think-first continuation、deliberation 遥测、已接受 relay、综合替换、陈旧 epoch 拒绝、owner-only journal 和完全停稳 dispose。无密钥整装示例固定模型可见投影、probe 指令、think-first 请求、综合 prompt 与持久 relay provenance。

## 后果

运行时减少确定性低价值情形的请求，并公开运行被跳过、boost、降档、抑制、综合或停止的原因。Anchor 与 verdict 让报告可比较，但不声称证明。全新 child 仍可复现，所有模型可见输入与 relay 仍可从持久 Session 数据重建。

该功能增加配置、进程内状态、可选额外综合调用与元数据 journal。Minimal context 可能移除有用指令，think-first 增加一个模型步骤，vendor 分类会随提供方演化降级为 unverified，holdout 替换也无法阻止语义披露。保守默认值使条件、vendor 偏好、衰减、预算、提升与综合保持 opt-in；value-loop journal 默认开启，但只含元数据。
