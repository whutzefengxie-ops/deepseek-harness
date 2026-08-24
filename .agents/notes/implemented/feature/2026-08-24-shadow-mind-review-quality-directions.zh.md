# Agent Note: Shadow Mind 审查质量机制

Status: implemented

[English](2026-08-24-shadow-mind-review-quality-directions.md) | 中文

## 问题

概率式一次性 reviewer 可以产生有用发现，但自由文本 prompt、独立抽样与自由文本报告不会公开某次运行是否针对已知失败类别、引用可见断言、重复较早发现、与 root 模型共享 vendor、反驳另一 reviewer，或耗尽合理的 Session 预算。在缺少这些控制时增加 reviewer，只会增加成本与 relay 体积，不会让输出更容易审计。

Ouroboros 审查谱系中有价值的机制很小且彼此可分：具体 probe class、零模型成本过滤、anchored 报告元数据、无状态重复检测、诚实 vendor 标签、触发式冲突综合、holdout 纪律和一等成本限制。它们属于现有 Shadow scheduler、registry、batcher 与生命周期，不需要引入另一套 workflow engine。

## 决策

Shadow Mind 在现有全新 child 编排之上实现八个审查质量方向。所有运行时阈值与路由都是经过验证的 settings 或定义字段。普通定义保留原行为默认值，starter library 则显式选择所需机制。集成架构与所有权边界记录在 [Shadow Mind 目标架构](2026-08-24-shadow-mind-target-architecture.zh.md)；运行条件单独记录在 [Shadow Mind 审查条件机制](2026-08-24-shadow-mind-review-conditioning.zh.md)。

## D1：Probe-class 类库

`PROBE_CLASSES_V1` 是六个面向轨迹类别的单一事实来源：失败工具调用、已脱敏参数、陈旧读取、误导性成功、重复失败与长输出。每项提供稳定 id、名称、触发条件与具体 probe。`renderProbeChecklist()` 生成 prompt block。

已交付的 `packages/shadow-mind/shadow-mind-runtime/examples/shadow-minds/` 类库包含 contrarian、hacker、researcher、simplifier 与 architect 定义。每个定义说明 persona 职责、嵌入生成 checklist、要求在 probe 未观察时报告 evidence gap 而非声称已运行，并请求 anchored 报告 envelope。该类库是 opt-in 示例内容，绝不会自动加载到 Harness home。

## D2：确定性谓词

谓词注册表针对持久事件分别提供 skip 与 boost map。Skip 谓词为 `last-report-covers`、`tool-failure` 与 `no-tool-calls`。Boost 谓词为 `misleading-success`、`repeated-failure` 与 `long-output`。定义通过 `pre_filter`、`boost_filter` 与 `boost_factor` 选择它们；未知 id 会拒绝文件。

Skip 在候选选中后、spawn 前发生，会增加 `prefilterSkips`，并在请求时追加仅含元数据的 debug 输出。Boost 在抽样前放大激活概率，并把结果限制为一。`tool-failure` 是普通 reviewer 的显式 skip，因为 root 已看到错误；`misleading-success` 与 `repeated-failure` 则保持为针对这些模式设计的 reviewer boost 信号。

## D3：Anchored 报告 envelope

终态报告要求 `verdict: 'challenge' | 'gap' | 'confirm' | 'uncertain'`。可选 `severity` 是零到一之间的有限数。`refs` 最多包含八个存在于确切投影视窗中的正数、有序、唯一 Session sequence。安静与不相关结果既没有内容，也没有 envelope 字段。

已接受 relay provenance 携带 verdict、severity、refs 与可选综合替换 id。路由与 vendor 独立性只保留为进程内状态和 debug 元数据，不进入模型可见历史。Relay 章节按 severity 降序排列。这些字段在持久 provenance 上都是可选项，`shadow-report` 事件仍可忽略，因此 `SESSION_FORMAT_VERSION` 保持为 `0`。

## D4：停滞与新颖性

进程内审查窗口保留有界元数据，绝不保留报告文本。它按定义检测重复相同 envelope 的 spinning、相同 refs 上 verdict 交替的 oscillation、重复相同 confirmation 的 no-drift，以及由已配置唯一 envelope 比例判定的 diminishing novelty。

检测会安装墙钟 `cooldownUntil`。提升开启时，oscillation 会先为一次运行预留 `reasoningEffortLadder` 中下一个可用项，再使定义进入冷却。状态公开冷却到期时间与待处理提升。真实用户消息会重置抑制与衰减；headless 运行依赖墙钟到期与提升，因为可能永远没有用户消息。

## D5：Reviewer 独立性

`vendorFamily()` 解析已确认的 provider 前缀与模型 marker。`resolveIndependence()` 返回 `independent`、`same_vendor`、`unverified` 或 `unavailable`；未知路由绝不表示独立。标签与已解析路由出现在终态状态和仅含元数据的 debug 记录中。

`preferIndependentVendor` 默认关闭。开启后，只有至少保留两个非同 vendor 候选时，才移除 same-vendor 候选。该可用性下限优先保留可用 jury，不制造误导性纯度主张。

## D6：冲突综合

一个已接受批次内，一方 verdict 为 `challenge`、另一方为 `confirm`，且 refs 重叠或任一方没有 refs 时，两份报告发生冲突。最多选择一个 pair：severity 差最小者优先，随后按合计 severity 最大者选择。综合默认关闭，并要求存在已启用且 id 为 `synthesizer` 的定义。

额外全新 child 只收到两个已脱敏报告文本、各自 verdict、severity、refs 与 synthesizer 指令。Prompt 明确说明它没有重新验证任何报告。有效的 `challenge`、`gap` 或 `confirm` 结果会替换该 pair，携带较弱输入的 severity，并记录两个 `replacesRunIds`。原条目仍以有界近期元数据形式可见。

所有失败都 fail-open：缺少定义、prompt 超限、硬预算耗尽、无效或安静输出、超时、取消、提供方或 dispose 失败，以及 epoch 改变，都会原样转发两个报告。仅含元数据的 `logs/synthesizer.jsonl` 记录尝试或原因，不含 prompt 或报告文本。

## D7：Holdout 纪律

定义通过 `holdout: true` 选择加入。其唯一且非空的 literal key 来自仅 owner 可读写的 `$DSH_HOME/shadow-minds/holdout-keys.json`；缺失或空条目会拒绝该运行。Key 不出现在定义文件、创作类型、工具、Remote 数据、浏览器表单、provenance、状态或 debug 输出中。

字面替换覆盖 root 轨迹投影、封装 child prompt、已接受报告文本、综合 prompt 与持久 relay。Relay invariant 会在持久化前检查 owner 已知 key。该机制不限制 filesystem 读取、不改变普通 child Session 持久化，也不检测转述，因此只是 sandbox 与披露策略的补充，不能替代它们。

## D8：Session 预算与陈旧报告衰减

每 root 的 `spentChars` 计算每个已准入 prompt 与已接受报告。可选软上限要求同时配置更大的硬上限与 `frugalShadowModel`；达到软上限后，后续符合条件的运行路由到该模型。达到硬上限后停止新 Shadow 与综合工作，但不取消已准入运行。状态报告 `standard`、`frugal` 或 `exhausted`。

已接受 envelope 重复时，该定义后续轮次的激活概率乘以 `1 - staleReportDecay`。默认零会禁用衰减。真实用户消息会同时重置消耗、衰减、冷却与提升状态。

## 考虑过的替代方案

**把 ouroboros runtime 作为依赖挂载。** 不采用，因为它会带入独立 workflow 与进程模型。Harness 自有模块使用现有 Session、subagent、settings 与生命周期 seam，并由本仓库门禁验证。

**只交付 prompt 示例。** 不作为完整设计，因为谓词、持久 anchor、重复、vendor 标签、综合 provenance、holdout 处理与预算需要运行时状态和验证。Probe 类库在更大设计内仍保持纯内容。

**为每个 root 轮次分配数值质量分数。** 不采用，因为不存在验证该分数的 ground truth。Anchored verdict 与诊断 challenge 结果公开可审计事实，而不假装直接测量正确性。

**即使只剩一个 reviewer 也优先独立性。** 不采用，因为单一 reviewer 不是可用冲突集合。只有两个非 same-vendor 候选仍存在时才应用过滤器。

**强制执行综合。** 不采用，因为它增加成本，并可能失败或扭曲两个输入。它保持 opt-in、只处理一个 pair，并保留确定性 fail-open 投递。

**把 holdout key 存入 frontmatter。** 不采用，因为定义、管理 API 与浏览器表单都是 root 可读界面。Owner 侧 sidecar 使 literal 离开这些路径，同时诚实说明有限保护。

## 验证

纯测试固定 probe 渲染与五个已交付定义、每个谓词与阈值、envelope 规范化与 invariant 拒绝、全部四种停滞模式、vendor 分类与可用性下限、冲突 pair 排序、综合 prompt 上限、字面替换、预算切换和陈旧衰减。运行时集成测试覆盖 debug 与 value-loop journal、same-vendor 过滤、冷却与提升、节省与硬预算、成功替换、每类综合 fail-open、跨 prompt 与 relay 的 holdout 脱敏、取消 epoch 与资源 dispose。管理与浏览器测试固定每个新定义、settings 与状态字段，同时证明 holdout key 没有管理界面。无密钥整装快照固定模型可见 probe、envelope、综合与 relay 契约。

## 后果

审查活动变得可观察且有界：操作方可以知道定义为什么运行、跳过、衰减、冷却、改变路由或调用综合。Anchor 允许确定性验证与比较，vendor 标签避免错误独立性主张，fail-open 综合绝不会隐藏两个原始发现。

这些机制增加配置与进程内记账。Probe 匹配与 challenge 分类仍是启发式，severity 只在一个 relay 内可比较，vendor 表可能降级为 unverified，字符预算近似成本而非 token 或货币。Holdout 替换只保护自有模型可见路径上的精确 literal。保守默认值让 vendor 过滤、衰减、预算、提升、综合与 holdout 保持 opt-in；所有诊断文件都省略轨迹与报告文本。
