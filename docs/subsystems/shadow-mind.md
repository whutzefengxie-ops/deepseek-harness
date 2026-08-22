# Shadow Mind

English | [中文](shadow-mind.zh.md)

Shadow Mind is opt-in root-agent background analysis owned by [dsh-shadow-mind-runtime](../../packages/shadow-mind/shadow-mind-runtime/README.md). After an eligible root turn, `ctx.shadowMind` may start fresh `spawn` subagents over a bounded reasoning-free projection and relay only accepted structured reports into the root Session. The [runtime README](../../packages/shadow-mind/shadow-mind-runtime/README.md) owns configuration, model experience, failure behavior, and limitations; the [decision record](../../.agents/notes/implemented/feature/2026-08-22-probabilistic-shadow-mind-orchestration.md) owns the Pi comparison and design rationale.

Source: [`packages/shadow-mind/shadow-mind-runtime/src/index.ts`](../../packages/shadow-mind/shadow-mind-runtime/src/index.ts)

## Definitions and catalog

Definitions are validated Markdown files under `$DSH_HOME/shadow-minds`. A catalog read isolates malformed files as diagnostics, sorts valid definitions by source path, and keeps the first valid source for a duplicate id. Definition mutations validate before atomic owner-only writes; the authoring types exclude derived filesystem fields.

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

## Scheduling and delivery

The runtime observes only root `agent/turn-end` events that completed with a durable tool result. Heartbeat and per-definition probability gates run independently; model globs and per-root capacity restrict the candidates. Each selected definition starts through the [subagent service](subagent.md) with `maxDepth: 1`, its configured model selection, an explicit tool allowlist, a structured-output schema, and the child approval policy fixed to `never` by in-process delegation.

An accepted `report` becomes a durable root `user/message` with `shadow-report` provenance. A running root receives the batch through `steer()` and an idle root through `followup()`. New user input, cancellation, pause, root disposal, and plugin disposal advance the root epoch, abort admitted children, and prevent stale delivery. Headless maintenance waits for scheduling, child disposal, batching, relay admission, and any resulting follow-up to reach quiescence.

## Settings and status

The live `shadow-mind` settings namespace resolves schema defaults, the plugin configuration base, and user overrides. `dshHome` belongs only to plugin configuration; it selects the Harness home containing definitions and debug logs and is not user-editable through that namespace.

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

Status is scoped to one root. `capturedThroughSeq` is the inclusive root Session watermark used to construct that run's prompt; a child Session id appears only after the provider publishes it. The epoch identifies the cancellation generation whose reports may still be admitted.

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

## Management entry points

The [tool package](../../packages/shadow-mind/tool-shadow-mind/README.md) consumes `ctx.shadowMind` through two read tools, six approval-gated mutation tools, and `/shadow status|pause|resume|toggle`. The installable [dsh-shadow-mind bundle](../../packages/bundle/shadow-mind/README.md) mounts the runtime and management consumer as a profile patch layer.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

Source: [`packages/shadow-mind/shadow-mind-runtime/src/index.ts`](../../packages/shadow-mind/shadow-mind-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
