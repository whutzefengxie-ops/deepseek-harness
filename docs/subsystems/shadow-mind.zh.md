# Shadow Mind

[English](shadow-mind.md) | 中文

Shadow Mind 是由 [dsh-shadow-mind-runtime](../../packages/shadow-mind/shadow-mind-runtime/README.zh.md) 负责的可选 root agent 后台分析功能。一个符合条件的 root 轮次结束后，`ctx.shadowMind` 可以基于有界且不含推理的投影启动全新 `spawn` subagent，并只把已接受的结构化报告转发到 root Session。[运行时 README](../../packages/shadow-mind/shadow-mind-runtime/README.zh.md) 负责配置、模型体验、失败行为与限制；[决策记录](../../.agents/notes/implemented/feature/2026-08-22-probabilistic-shadow-mind-orchestration.zh.md) 负责 Pi 对比与设计理由。

源码：[`packages/shadow-mind/shadow-mind-runtime/src/index.ts`](../../packages/shadow-mind/shadow-mind-runtime/src/index.ts)

## 定义与目录

定义是 `$DSH_HOME/shadow-minds` 下经过验证的 Markdown 文件。目录读取把格式错误的文件隔离为诊断，按源路径排序有效定义，并在 id 重复时保留第一个有效来源。定义变更先验证，再执行仅 owner 可读写的原子写入；创作类型不含派生的文件系统字段。

```ts type-equiv
/** One validated Markdown-backed Shadow definition. */
interface ShadowDefinition {
  /** Stable lowercase identifier. */
  readonly id: string
  /** Human-readable name used in reports and diagnostics. */
  readonly name: string
  /** Whether scheduling may select this Shadow. */
  readonly enabled: boolean
  /** Whether completed runs append local diagnostic records. */
  readonly debug: boolean
  /** Independent activation probability after the heartbeat gate passes. */
  readonly activationProbability: number
  /** Optional model globs that make this Shadow eligible. */
  readonly activeForModels: readonly string[]
  /** Optional `provider/model` route for this Shadow run. */
  readonly runWithModel?: string
  /** Optional adapter-owned reasoning effort for this Shadow run. */
  readonly reasoningEffort?: string
  /** Optional run deadline in seconds. */
  readonly timeoutSeconds?: number
  /** Explicit tools added to the default read-only set. */
  readonly tools: readonly string[]
  /** Root-log range projected into each run. */
  readonly capture: 'full' | 'since-compaction'
  /** Whether ordinary child runtime context and pre-step injections are inherited. */
  readonly context: 'standard' | 'minimal'
  /** Whether the child plans against numbered anchors before tools become visible. */
  readonly thinkFirst: boolean
  /** Named deterministic predicates that skip a selected run. */
  readonly preFilters: readonly string[]
  /** Named deterministic predicates that raise activation probability. */
  readonly boostFilters: readonly string[]
  /** Multiplier applied when any configured boost predicate matches. */
  readonly boostFactor: number
  /** Whether owner-only sidecar literals must be redacted from this run. */
  readonly holdout: boolean
  /** Shadow-specific instructions from the Markdown body. */
  readonly prompt: string
  /** Absolute source Markdown path. */
  readonly sourcePath: string
}
```

```ts type-equiv
/** One definition file that could not join the active catalog. */
interface ShadowDiagnostic {
  /** Absolute source path. */
  readonly path: string
  /** Stable human-readable parse, validation, or duplicate-id error. */
  readonly error: string
}
```

```ts type-equiv
/** Fresh catalog snapshot loaded from disk. */
interface ShadowCatalog {
  /** Valid definitions, sorted by source path and deduplicated by id. */
  readonly definitions: readonly ShadowDefinition[]
  /** File-local failures that did not hide other valid definitions. */
  readonly diagnostics: readonly ShadowDiagnostic[]
}
```

受信任的 Web 管理 API 会在目录读取结果中加入定义目录，并对可选字段使用可空值，使完整编辑可以显式恢复继承的执行设置。

```ts type-equiv
/** Catalog snapshot served to the trusted Web administration page. */
interface ShadowAdministrationSnapshot extends ShadowCatalog {
  /** Directory containing the Markdown definition files. */
  readonly definitionRoot: string
}
```

```ts type-equiv
/** Complete editable definition submitted by the Web administration page. */
interface ShadowDefinitionInput {
  /** Stable lowercase identifier. */
  readonly id: string
  /** Human-readable name. */
  readonly name: string
  /** Whether automatic scheduling may select this Shadow. */
  readonly enabled: boolean
  /** Whether completed runs append local diagnostic records. */
  readonly debug: boolean
  /** Independent activation probability from zero through one. */
  readonly activationProbability: number
  /** Model or provider/model globs that make this Shadow eligible. */
  readonly activeForModels: readonly string[]
  /** Execution route, or null to inherit the runtime default. */
  readonly runWithModel: string | null
  /** Adapter-owned reasoning effort, or null to inherit the runtime default. */
  readonly reasoningEffort: string | null
  /** Per-run deadline, or null to inherit the runtime default. */
  readonly timeoutSeconds: number | null
  /** Tools added to the default Shadow allowlist. */
  readonly tools: readonly string[]
  /** Root-log range projected into each run. */
  readonly capture: 'full' | 'since-compaction'
  /** Whether ordinary child runtime context and pre-step injections are inherited. */
  readonly context: 'standard' | 'minimal'
  /** Whether the child plans against numbered anchors before tools become visible. */
  readonly thinkFirst: boolean
  /** Named deterministic predicates that skip a selected run. */
  readonly preFilters: readonly string[]
  /** Named deterministic predicates that raise activation probability. */
  readonly boostFilters: readonly string[]
  /** Multiplier applied when any configured boost predicate matches. */
  readonly boostFactor: number
  /** Whether owner-only sidecar literals must be redacted from this run. */
  readonly holdout: boolean
  /** Non-empty Shadow instructions. */
  readonly prompt: string
}
```

```ts type-equiv
/** Authoring fields accepted when creating a definition; conditioning defaults preserve legacy files and callers. */
type CreateShadowDefinition = Omit<
  ShadowDefinition,
  'sourcePath' | 'capture' | 'context' | 'thinkFirst'
  | 'preFilters' | 'boostFilters' | 'boostFactor' | 'holdout'
> & Partial<Pick<
  ShadowDefinition,
  'capture' | 'context' | 'thinkFirst' | 'preFilters' | 'boostFilters' | 'boostFactor' | 'holdout'
>>
```

```ts type-equiv
/** Mutable definition fields accepted by an update; explicit undefined clears optional execution overrides. */
type UpdateShadowDefinition = Partial<Omit<
  CreateShadowDefinition,
  'id' | 'runWithModel' | 'reasoningEffort' | 'timeoutSeconds'
>> & {
  readonly runWithModel?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly timeoutSeconds?: number | undefined
}
```

## 调度与投递

运行时只观察以持久化工具结果完成的 root `agent/turn-end` 事件。Heartbeat、具名 skip 与 boost 谓词、有效概率、vendor 偏好、墙钟冷却、Session 预算、模型 glob 和每 root 容量共同决定准入。每个入选定义都通过 [subagent 服务](subagent.zh.md) 启动，使用 `maxDepth: 1`、定义所选模型、显式工具 allowlist、可选 minimal context 与 think-first 条件、结构化输出 schema，并由进程内委派把 child 审批策略固定为 `never`。

投影行携带持久 sequence anchor。`since-compaction` 从最近一个已截获 compaction 边界之后开始，同时保留 compaction summary。已接受报告携带 challenge、gap、confirm 或 uncertain verdict、受限 severity，以及指向该投影视窗的 anchor。重复检测可以冷却或提升定义，软预算选择节省路由，硬预算停止新工作。Challenge 采纳分类只产生元数据诊断，不参与调度。

已接受的 `report` 会变成带 `shadow-report` 来源信息的持久化 root `user/message`。报告按 severity 排序。可选冲突综合最多替换一对 challenge／confirm 报告，并在不可用、无效、已取消、超时或超预算路径全部向两个原报告 fail-open。运行中的 root 通过 `steer()` 接收批次，空闲 root 通过 `followup()` 接收。新的用户输入、取消、暂停、root dispose 和插件 dispose 会推进 root epoch、中止已准入 child 与综合工作，并阻止陈旧投递。Headless maintenance 会等待调度、child dispose、批处理、relay 准入及由此产生的 follow-up 全部达到完全停稳。

Holdout literal 只存在于 owner 可读的 `$DSH_HOME/shadow-minds/holdout-keys.json`。字面替换覆盖运行时投影、child 与综合 prompt、已接受报告文本和持久化 relay；key 不进入定义、Remote 数据、UI、provenance 或 debug 记录。它不是 filesystem sandbox：普通 child Session 持久化与继承的工具访问仍然生效，转述也可能绕过字面替换。

## 会话展示

持久化 `user/message` 仍是报告展示的唯一数据源。通用消息 Definition 继续负责排序、重放与 Location 归属，会话 UI 则提供按来源种类选择的上下文行插槽。Shadow Mind 浏览器插件认领 `shadow-report` 并把报告批次渲染成专属卡片；移除插件后会恢复通用上下文折叠行，不会改变 Session 日志。

一个 relay 可以包含多个 `source.reports` 条目。Renderer 会把这些条目与面向模型的报告章节对应起来，并展示每个 Shadow 的名称与 id、报告正文、child Session id 和 `capturedThroughSeq`。来源或报告正文不可读时会回退到通用上下文行，确保持久化内容不会被隐藏。

一个不输出视图节点的 Conversation Definition 会把 `shadow-report` 输入折叠到所属轮次的类型化数据中。插件只在该数据存在时贡献轮次尾标记，把**由 Shadow Mind 报告触发**放在 root Assistant 收尾回复下方。`silent`、`not_relevant`、`failed` 和 `discarded` 不产生持久化 relay，只在当前会话的管理状态中显示。

## 设置与状态

实时 `shadow-mind` settings namespace 依次解析 schema 默认值、插件配置基值和用户覆盖。一次运行时 settings 更新会原子设置已提供字段，并移除以 `null` 表示的可选用户覆盖。`dshHome` 只属于插件配置；它选择存放定义与调试日志的 Harness home，不能通过该 namespace 作为用户设置编辑。Web profile 会在**设置 → 插件 → Shadow Mind**公开可由用户编辑的字段。

```ts type-equiv
/** Live scheduling and projection settings owned by the user. */
interface ShadowMindSettings {
  /** Probability that an eligible tool-using root turn enters Shadow scheduling. */
  readonly heartbeatProbability: number
  /** Maximum active Shadow runs per root agent. */
  readonly maxParallelShadows: number
  /** Default run deadline when a definition omits one. */
  readonly defaultShadowTimeoutSeconds: number
  /** Maximum headless wait after a root turn. */
  readonly headlessDrainTimeoutSeconds: number
  /** Window used to combine accepted reports into one relay. */
  readonly resultBatchWindowMs: number
  /** Optional fallback `provider/model` route. */
  readonly defaultShadowModel?: string
  /** Optional fallback adapter-owned reasoning effort. */
  readonly defaultReasoningEffort?: string
  /** Whether tool-call arguments are omitted or copied into Shadow prompts. */
  readonly argumentDisclosure: 'redacted' | 'full'
  /** Optional deterministic random seed. */
  readonly randomSeed?: number
  /** Maximum complete framed prompt size. */
  readonly maxPromptChars: number
  /** Maximum accepted report size. */
  readonly maxReportChars: number
  /** Prefer positively independent reviewer vendors without collapsing the candidate jury. */
  readonly preferIndependentVendor: boolean
  /** Durable tool-result character count that activates the `long-output` boost predicate. */
  readonly longOutputBoostChars: number
  /** Consecutive identical report envelopes required by `last-report-covers`. */
  readonly lastReportCoversCount: number
  /** Same-tool failures in one turn required by `repeated-failure`. */
  readonly repeatedFailureBoostThreshold: number
  /** Whether accepted challenges are classified against later root behavior. */
  readonly valueLoopEnabled: boolean
  /** Completed root turns observed before an unanswered challenge becomes ignored. */
  readonly valueLoopWindowTurns: number
  /** Accepted entries retained for stagnation and novelty analysis. */
  readonly reviewWindowSize: number
  /** Consecutive identical envelopes required for spinning detection. */
  readonly spinningRepeatCount: number
  /** Alternating verdict periods required for oscillation detection. */
  readonly oscillationPeriods: number
  /** Consecutive unchanged confirmations required for no-drift detection. */
  readonly noDriftRepeatCount: number
  /** Suffix length used by diminishing-novelty detection. */
  readonly diminishingWindowSize: number
  /** Novel envelope share below which a full suffix is diminishing. */
  readonly diminishingNoveltyThreshold: number
  /** Wall-clock duration applied to a detected definition. */
  readonly stagnationCooldownSeconds: number
  /** Whether oscillation may spend the next reasoning-effort rung instead of cooling down. */
  readonly stagnationEscalationEnabled: boolean
  /** Ordered adapter-owned reasoning effort ids used for one-rung escalation. */
  readonly reasoningEffortLadder: readonly string[]
  /** Optional character spend that activates the frugal route. */
  readonly sessionShadowSoftBudgetChars?: number
  /** Optional character spend that stops new Shadow runs. */
  readonly sessionShadowHardBudgetChars?: number
  /** Optional provider/model route used after the soft budget. */
  readonly frugalShadowModel?: string
  /** Multiplicative probability decay for repeated report envelopes. */
  readonly staleReportDecay: number
  /** Whether one conflicting challenge/confirm pair may invoke a synthesizer. */
  readonly conflictSynthesisEnabled: boolean
  /** Deadline for the additional conflict-synthesis run. */
  readonly conflictSynthesisTimeoutSeconds: number
}
```

```ts type-equiv
/** Partial live-settings write; null removes one optional user override. */
type UpdateShadowMindSettings = Partial<Omit<
  ShadowMindSettings,
  | 'defaultShadowModel'
  | 'defaultReasoningEffort'
  | 'randomSeed'
  | 'sessionShadowSoftBudgetChars'
  | 'sessionShadowHardBudgetChars'
  | 'frugalShadowModel'
>> & {
  readonly defaultShadowModel?: string | null
  readonly defaultReasoningEffort?: string | null
  readonly randomSeed?: number | null
  readonly sessionShadowSoftBudgetChars?: number | null
  readonly sessionShadowHardBudgetChars?: number | null
  readonly frugalShadowModel?: string | null
}
```

```ts type-equiv
/** Runtime plugin configuration. */
interface ShadowMindConfig extends Partial<ShadowMindSettings> {
  /** Harness home used for definitions and debug logs. */
  readonly dshHome?: string
}
```

状态只属于一个 root。`capturedThroughSeq` 是构造该次运行 prompt 时所用的 root Session 包含式水位；只有提供方发布 child 后才会出现 child Session id。Epoch 标识其报告仍可准入的取消代次。`totalRuns` 和 `lastRun` 会在活动工作消失后保留进程内证据；终态结果区分已回传报告、有效的无补充结果、已丢弃结果与失败。

```ts type-equiv
/** One active Shadow run shown in runtime status. */
interface ActiveShadowStatus {
  /** Shadow definition id. */
  readonly shadowId: string
  /** Child session id when the provider has published it. */
  readonly childSessionId?: SessionId
  /** Session sequence captured for the prompt. */
  readonly capturedThroughSeq: number
}
```

```ts type-equiv
/** User-facing terminal classification for one admitted Shadow run. */
type ShadowRunOutcome = 'report' | 'silent' | 'not_relevant' | 'discarded' | 'failed'
```

```ts type-equiv
/** Epistemic classification carried by an accepted Shadow finding. */
type ShadowVerdict = 'challenge' | 'gap' | 'confirm' | 'uncertain'
```

```ts type-equiv
/** Honest relationship between the root and reviewer model vendors. */
type ShadowIndependence = 'independent' | 'unverified' | 'unavailable' | 'same_vendor'
```

```ts type-equiv
/** Most recently finished Shadow run for one root. */
interface LastShadowRunStatus {
  /** Shadow definition id. */
  readonly shadowId: string
  /** Child session id when the provider published it. */
  readonly childSessionId?: SessionId
  /** Session sequence captured for the prompt. */
  readonly capturedThroughSeq: number
  /** Completion time in ISO 8601 format. */
  readonly finishedAt: string
  /** Whether the run reported, stayed silent, was discarded, or failed. */
  readonly outcome: ShadowRunOutcome
  /** Streamed text and reasoning characters before structured output. */
  readonly deliberationChars: number
  /** Verdict of an accepted report. */
  readonly verdict?: ShadowVerdict
  /** Reviewer-vendor relationship computed from resolved routes. */
  readonly independence: ShadowIndependence
  /** Resolved provider/model route used by the run. */
  readonly route?: string
}
```

```ts type-equiv
/** Per-root runtime status. */
interface ShadowMindStatus {
  /** Whether automatic scheduling is paused. */
  readonly paused: boolean
  /** Active runs in start order. */
  readonly active: readonly ActiveShadowStatus[]
  /** Number of turn schedules still loading or admitting work. */
  readonly pendingSchedules: number
  /** Current cancellation epoch. */
  readonly epoch: number
  /** Number of Shadow runs admitted during this root's process lifetime. */
  readonly totalRuns: number
  /** Most recently finished run during this root's process lifetime. */
  readonly lastRun?: LastShadowRunStatus
  /** Number of deterministic pre-filter skips during this root's process lifetime. */
  readonly prefilterSkips: number
  /** Last per-definition activation probabilities after deterministic boosts. */
  readonly effectiveProbabilities: readonly ShadowEffectiveProbability[]
  /** Diagnostic challenge outcomes by definition during this process lifetime. */
  readonly valueLoop: readonly ShadowValueLoopStatus[]
  /** Prompt plus accepted-report characters spent since the latest real user input. */
  readonly spentChars: number
  /** Current budget routing tier. */
  readonly budgetTier: 'standard' | 'frugal' | 'exhausted'
  /** Non-expired per-definition wall-clock cooldowns. */
  readonly cooldowns: readonly ShadowCooldownStatus[]
  /** Definitions whose next admitted run will use one higher reasoning-effort rung. */
  readonly pendingEscalations: readonly string[]
  /** Recent accepted report metadata, including reports replaced by synthesis. */
  readonly recentReviews: readonly ShadowReviewStatus[]
  /** Conflict-synthesis runs admitted during this process lifetime. */
  readonly synthesisRuns: number
  /** Conflict-synthesis attempts that failed open during this process lifetime. */
  readonly synthesisFailures: number
  /** Latest fail-open reason. */
  readonly lastSynthesisFailure?: string
}
```

状态辅助类型是运行时公共 API 中的 `ShadowEffectiveProbability`、`ShadowValueLoopStatus`、`ShadowCooldownStatus` 与 `ShadowReviewStatus`。它们公开定义 id、计数、时间戳、anchor、verdict、概率与模式 id，但不公开报告文本、轨迹文本、holdout literal 或 reasoning 内容。新增 provenance 字段均为可选且可忽略，不改变 Session 日志结构，因此 `SESSION_FORMAT_VERSION` 保持为 `0`。

## 管理入口

[工具包](../../packages/shadow-mind/tool-shadow-mind/README.zh.md) 通过两个读取工具、六个需要审批的变更工具和 `/shadow status|pause|resume|toggle` 使用 `ctx.shadowMind`。[浏览器包](../../packages/client/ui-shadow-mind/README.zh.md) 会挂载生成的 Remote contribution，在**设置 → 插件 → Shadow Mind**管理 settings 与定义、控制当前所选 root，并通过 composer 提示通道显示 `/shadow` 结果。可安装的 [dsh-shadow-mind 组合包](../../packages/bundle/shadow-mind/README.zh.md) 把三个包都作为 profile patch 层挂载。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxshadowmind--shadowmindruntime"></a>

### `ctx.shadowMind` — `ShadowMindRuntime`

Root-only Shadow orchestration service.

```ts cordis-catalog
/**
 * Load the current definition catalog.
 * @returns Current valid definitions and isolated file diagnostics.
 */
listDefinitions(): Promise<ShadowCatalog>

/**
 * Load definitions and their storage directory for the trusted Web administration page.
 * @returns Current catalog and definition directory.
 */
@Remote('catalog') async remoteExportCatalog(): Promise<ShadowAdministrationSnapshot>

/**
 * Create one complete definition submitted by the Web administration page.
 * @param input Validated wire fields.
 * @returns Persisted definition.
 */
@Remote('create') remoteExportCreate(input: ShadowDefinitionInput): Promise<ShadowDefinition>

/**
 * Replace every editable field of one definition from the Web administration page.
 * @param input Complete wire fields including the existing id.
 * @returns Persisted definition.
 */
@Remote('update') remoteExportUpdate(input: ShadowDefinitionInput): Promise<ShadowDefinition>

/**
 * Enable or disable one definition from the Web administration page.
 * @param id Definition id.
 * @param enabled Next scheduling state.
 * @returns Persisted definition.
 */
@Remote('setEnabled') remoteExportSetEnabled(id: string, enabled: boolean): Promise<ShadowDefinition>

/**
 * Delete one definition from the Web administration page while preserving its debug log.
 * @param id Definition id.
 */
@Remote('delete') remoteExportDelete(id: string): Promise<void>

/**
 * Create a definition atomically.
 * @param input Complete definition fields.
 * @returns Validated persisted definition.
 */
createDefinition(input: CreateShadowDefinition): Promise<ShadowDefinition>

/**
 * Update a definition atomically.
 * @param id Existing definition id.
 * @param patch Fields to replace.
 * @returns Updated validated definition.
 */
updateDefinition(id: string, patch: UpdateShadowDefinition): Promise<ShadowDefinition>

/**
 * Enable or disable a definition atomically.
 * @param id Existing definition id.
 * @param enabled Next scheduling state.
 * @returns Updated validated definition.
 */
setEnabled(id: string, enabled: boolean): Promise<ShadowDefinition>

/**
 * Delete a definition while preserving debug logs.
 * @param id Existing definition id.
 */
deleteDefinition(id: string): Promise<void>

/**
 * Return the current immutable resolved settings.
 * @returns Live resolved settings snapshot.
 */
currentSettings(): ShadowMindSettings

/**
 * Atomically persist selected settings; null removes an optional user override.
 * @param patch Settings fields to set or clear.
 * @returns A promise settled after the settings mutation commits.
 */
updateSettings(patch: UpdateShadowMindSettings): Promise<void>

/**
 * Return per-root orchestration status without creating state for an untouched root.
 * @param agent Root agent to inspect.
 * @returns Current scheduling and run status.
 */
@Remote('status') status(agent: Agent): ShadowMindStatus

/**
 * Pause scheduling for a root and cancel its admitted work.
 * @param agent Root agent to pause.
 * @returns Status after the transition.
 */
@Remote('pause') pause(agent: Agent): ShadowMindStatus

/**
 * Resume future scheduling for a root.
 * @param agent Root agent to resume.
 * @returns Status after the transition.
 */
@Remote('resume') resume(agent: Agent): ShadowMindStatus

/**
 * Toggle automatic scheduling for a root.
 * @param agent Root agent to update.
 * @returns Status after the transition.
 */
@Remote('toggle') toggle(agent: Agent): ShadowMindStatus
```

Types: [Agent](core.zh.md)

Source: [`packages/shadow-mind/shadow-mind-runtime/src/index.ts`](../../packages/shadow-mind/shadow-mind-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
