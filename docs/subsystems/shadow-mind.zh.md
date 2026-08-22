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

```ts type-equiv
/** Authoring fields accepted when creating a definition. */
type CreateShadowDefinition = Omit<ShadowDefinition, 'sourcePath'>
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

运行时只观察以持久化工具结果完成的 root `agent/turn-end` 事件。Heartbeat 与每定义概率门槛彼此独立；模型 glob 和每 root 容量会进一步限制候选定义。每个入选定义都通过 [subagent 服务](subagent.zh.md) 启动，使用 `maxDepth: 1`、定义所选模型、显式工具 allowlist、结构化输出 schema，并由进程内委派把 child 审批策略固定为 `never`。

已接受的 `report` 会变成带 `shadow-report` 来源信息的持久化 root `user/message`。运行中的 root 通过 `steer()` 接收批次，空闲 root 通过 `followup()` 接收。新的用户输入、取消、暂停、root dispose 和插件 dispose 会推进 root epoch、中止已准入 child，并阻止陈旧投递。Headless maintenance 会等待调度、child dispose、批处理、relay 准入及由此产生的 follow-up 全部达到完全停稳。

## 设置与状态

实时 `shadow-mind` settings namespace 依次解析 schema 默认值、插件配置基值和用户覆盖。`dshHome` 只属于插件配置；它选择存放定义与调试日志的 Harness home，不能通过该 namespace 作为用户设置编辑。

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
}
```

```ts type-equiv
/** Runtime plugin configuration. */
interface ShadowMindConfig extends Partial<ShadowMindSettings> {
  /** Harness home used for definitions and debug logs. */
  readonly dshHome?: string
}
```

状态只属于一个 root。`capturedThroughSeq` 是构造该次运行 prompt 时所用的 root Session 包含式水位；只有提供方发布 child 后才会出现 child Session id。Epoch 标识其报告仍可准入的取消代次。

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
}
```

## 管理入口

[工具包](../../packages/shadow-mind/tool-shadow-mind/README.zh.md) 通过两个读取工具、六个需要审批的变更工具和 `/shadow status|pause|resume|toggle` 使用 `ctx.shadowMind`。可安装的 [dsh-shadow-mind 组合包](../../packages/bundle/shadow-mind/README.zh.md) 把运行时和管理 Consumer 作为 profile patch 层挂载。

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
 * Persist a partial user-settings patch.
 * @param patch Settings fields to replace.
 */
updateSettings(patch: Partial<ShadowMindSettings>): Promise<void>

/**
 * Return per-root orchestration status without creating state for an untouched root.
 * @param agent Root agent to inspect.
 * @returns Current scheduling and run status.
 */
status(agent: Agent): ShadowMindStatus

/**
 * Pause scheduling for a root and cancel its admitted work.
 * @param agent Root agent to pause.
 * @returns Status after the transition.
 */
pause(agent: Agent): ShadowMindStatus

/**
 * Resume future scheduling for a root.
 * @param agent Root agent to resume.
 * @returns Status after the transition.
 */
resume(agent: Agent): ShadowMindStatus

/**
 * Toggle automatic scheduling for a root.
 * @param agent Root agent to update.
 * @returns Status after the transition.
 */
toggle(agent: Agent): ShadowMindStatus
```

Types: [Agent](core.zh.md)

Source: [`packages/shadow-mind/shadow-mind-runtime/src/index.ts`](../../packages/shadow-mind/shadow-mind-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
