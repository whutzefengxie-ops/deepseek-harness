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

The trusted Web administration API adds the definition directory to catalog reads and uses nullable optional fields so a complete edit can explicitly restore inherited execution settings.

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

## Scheduling and delivery

The runtime observes only root `agent/turn-end` events that completed with a durable tool result. Heartbeat, named skip and boost predicates, effective probability, vendor preference, wall-clock cooldown, session budget, model globs, and per-root capacity determine admission. Each selected definition starts through the [subagent service](subagent.md) with `maxDepth: 1`, its configured model selection, an explicit tool allowlist, optional minimal context and think-first conditioning, a structured-output schema, and the child approval policy fixed to `never` by in-process delegation.

Projection lines carry durable sequence anchors. `since-compaction` begins after the latest captured compaction boundary while keeping compaction summaries. Accepted reports carry a challenge, gap, confirmation, or uncertain verdict with bounded severity and anchors into that exact projected window. Repetition detection can cool down or escalate a definition, the soft budget selects a frugal route, and the hard budget stops new work. Challenge adoption classification is metadata-only diagnostic output and does not feed scheduling.

An accepted `report` becomes a durable root `user/message` with `shadow-report` provenance. Reports sort by severity. Optional conflict synthesis replaces at most one challenge/confirm pair and fails open to both originals on every unavailable, invalid, cancelled, timed-out, or over-budget path. A running root receives the batch through `steer()` and an idle root through `followup()`. New user input, cancellation, pause, root disposal, and plugin disposal advance the root epoch, abort admitted child and synthesis work, and prevent stale delivery. Headless maintenance waits for scheduling, child disposal, batching, relay admission, and any resulting follow-up to reach quiescence.

Holdout literals live only in owner-readable `$DSH_HOME/shadow-minds/holdout-keys.json`. Literal replacement covers runtime projection, child and synthesis prompts, accepted report text, and the durable relay; keys do not enter definitions, Remote data, UI, provenance, or debug records. This is not a filesystem sandbox: ordinary child Session persistence and inherited tool access still apply, and paraphrases can bypass literal replacement.

## Conversation presentation

The durable `user/message` remains the only source for report presentation. The generic message Definition therefore continues to own ordering, replay, and Location assignment, while the conversation UI exposes a source-kind keyed context-row seat. The Shadow Mind browser plugin claims `shadow-report` and renders the report batch as a dedicated card; removing the plugin restores the generic context disclosure without changing the Session log.

One relay can contain several `source.reports` entries. The renderer pairs those entries with the report sections in the model-facing text and shows each Shadow name and id, report text, child Session id, and `capturedThroughSeq`. An unreadable source or report body falls back to the generic context row so persisted content is never hidden.

A target-free Conversation Definition folds `shadow-report` inputs into the owning Turn's typed data. The plugin contributes a turn-tail marker only when that data exists, placing **Triggered by a Shadow Mind report** below the closing root Assistant response. `silent`, `not_relevant`, `failed`, and `discarded` outcomes do not create durable relays and remain visible only in current-session administration status.

## Settings and status

The live `shadow-mind` settings namespace resolves schema defaults, the plugin configuration base, and user overrides. `dshHome` belongs only to plugin configuration; it selects the Harness home containing definitions and debug logs and is not user-editable through that namespace. Web profiles expose the user-editable fields at **Settings → Plugins → Shadow Mind**.

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
/** Runtime plugin configuration. */
interface ShadowMindConfig extends Partial<ShadowMindSettings> {
  /** Harness home used for definitions and debug logs. */
  readonly dshHome?: string
}
```

Status is scoped to one root. `capturedThroughSeq` is the inclusive root Session watermark used to construct that run's prompt; a child Session id appears only after the provider publishes it. The epoch identifies the cancellation generation whose reports may still be admitted. `totalRuns` and `lastRun` retain process-local evidence after active work disappears; the terminal outcome distinguishes relayed reports, valid quiet results, discarded results, and failures.

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

The status companion types are `ShadowEffectiveProbability`, `ShadowValueLoopStatus`, `ShadowCooldownStatus`, and `ShadowReviewStatus` from the runtime public API. They expose definition ids, counts, timestamps, anchors, verdicts, probabilities, and pattern ids, but never report text, trajectory text, holdout literals, or reasoning content. Optional provenance additions are ignorable and do not change the Session log structure, so `SESSION_FORMAT_VERSION` remains `0`.

## Management entry points

The [tool package](../../packages/shadow-mind/tool-shadow-mind/README.md) consumes `ctx.shadowMind` through two read tools, six approval-gated mutation tools, and `/shadow status|pause|resume|toggle`. The [browser package](../../packages/client/ui-shadow-mind/README.md) mounts the generated Remote contribution, manages settings and definitions under **Settings → Plugins → Shadow Mind**, controls the selected root, and surfaces `/shadow` results through the composer notice channel. The installable [dsh-shadow-mind bundle](../../packages/bundle/shadow-mind/README.md) mounts all three packages as a profile patch layer.

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
 * Persist a partial user-settings patch.
 * @param patch Settings fields to replace.
 */
updateSettings(patch: Partial<ShadowMindSettings>): Promise<void>

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

Types: [Agent](core.md)

Source: [`packages/shadow-mind/shadow-mind-runtime/src/index.ts`](../../packages/shadow-mind/shadow-mind-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
