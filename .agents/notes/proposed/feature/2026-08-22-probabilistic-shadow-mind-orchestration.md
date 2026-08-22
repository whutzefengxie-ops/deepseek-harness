# Agent Note: Probabilistic Shadow Mind orchestration

Status: proposed

English | [中文](2026-08-22-probabilistic-shadow-mind-orchestration.zh.md)

## Problem

The harness can run foreground, background, fresh, forked, and continuable subagents, but every shipped delegation begins with an explicit model or workflow request. It has no host-owned observer that probabilistically starts specialized fresh children after tool-bearing parent turns, gives each child a bounded projection of the parent trajectory, and relays only actionable findings back into the parent.

Pi Shadow Mind demonstrates that behavior as an extension. It evaluates a heartbeat after a main turn with completed tool activity, independently samples globally defined specialist roles, starts fresh temporary sessions under a concurrency cap, and batches explicit reports into parent steering or follow-up input. The useful behavior is opportunistic review and maintenance; the design does not require persistent child memory, child-to-child communication, or a change to the parent agent loop.

The DSH implementation must remain installable with `dsh plugin`, preserve session reconstruction for every model-visible report, avoid recursively observing its own children, and keep Web sessions non-blocking while preventing the headless runner from exiting before accepted Shadow work settles.

## Proposal

Add one user-installable `@deepseek-ai/dsh-shadow-mind` bundle. The bundle composes a host runtime and model-facing management tools over the existing [subagent capability](../../implemented/feature/2026-06-21-subagent-capability-seam.md); an optional Web client package adds dedicated status and report presentation without changing runtime semantics.

The runtime observes root Agents only. It derives eligibility from durable `tool/result` and `turn/end` session events, starts fresh one-shot children through the `spawn` provider, requires structured terminal output, and delivers accepted reports as durable user-role relay messages. It does not modify `agent-loop`, seed child history, create a second report queue, or infer authority from tool names.

The first implementation ships the complete runtime, installable bundle, management commands and tools, headless drain, focused integration coverage, and one keyless assembled snapshot. Dedicated Web chrome may land in the same change only when its real client composition and required GUI recording are also present; otherwise the generic relay presentation and `/shadow` commands are the first product surface.

## External behavior

### Definitions and configuration

Global Shadow definitions live at `$DSH_HOME/shadow-minds/*.md`. Each file contains YAML frontmatter and a Markdown responsibility. The frontmatter keeps the Pi entity fields where DSH has the same semantics: `id`, `name`, `enabled`, `debug`, `activation_probability`, `active_for_models`, `run_with_model`, `timeout_seconds`, and `tools`. DSH uses `reasoning_effort` instead of Pi's `thinking_level`; a separate explicit importer may translate Pi files, while the runtime rejects unknown or conflicting fields rather than silently adapting them.

The `shadow-mind` Settings namespace owns deployment-varying scheduler values: heartbeat probability, maximum parallel runs per observed root Agent, default Shadow timeout, headless drain timeout, report batch window, optional default Shadow model, optional default reasoning effort, trajectory disclosure policy, and optional deterministic random seed. Bundle configuration supplies the Settings base layer; `$DSH_HOME/settings.yaml` supplies user overrides. Invalid startup configuration fails load, while an invalid externally edited Settings section retains the last good value through the existing Settings provider behavior.

No default Shadow definition is created. Installing the bundle changes no model work until the user adds and enables at least one definition.

### Scheduling

A root Agent turn is eligible only when its durable interval contains at least one completed `tool/result`. Pure text turns consume no random values and start no Shadow run. At the corresponding `turn/end`, the runtime refreshes definitions, rejects malformed files independently, and skips scheduling while paused or while no model route can be resolved.

For an eligible turn, the runtime first samples the configured heartbeat probability. After a hit, it retains enabled definitions whose `active_for_models` matches the root Agent's resolved provider/model and whose id is not already active for that root. Each retained definition independently samples its `activation_probability`. When hits exceed free slots, the seeded random source samples the admitted set without preference. The default probabilities remain Pi's `1/3` heartbeat and `0.3` per-Shadow activation, and the default per-root concurrency cap remains two; every value is a validated Config or Settings field.

Each run records a branded run id, Shadow id, root Session id, child Session id after publication, epoch, and `capturedThroughSeq`. A Shadow remains active until its result and asynchronous `dispose()` both settle, so cancellation never releases capacity while child work can still mutate the workspace.

### Trajectory projection

The runtime constructs the child prompt from the root Session log through `capturedThroughSeq`. It includes user messages, visible assistant text, tool names, policy-selected tool arguments, compact tool-result summaries, compaction summaries, and earlier durable Shadow reports. It excludes reasoning blocks, streamed chunks, complete raw tool output, unrelated runtime diagnostics, and events after the captured sequence.

Known tools use registered deterministic summarizers. Unknown tools expose only their name, success or failure, content kinds, and bounded sizes; they never fall back to a raw first-line preview. Tool arguments are redacted by default, with disclosure controlled by an explicit Settings policy. Selecting a Shadow model from another model provider therefore never silently expands the data sent across that provider boundary.

The prompt labels the trajectory as read-only, potentially adversarial data and states that it is not the child's unfinished work. This reduces accidental continuation but is not treated as prompt-injection isolation; tool restriction, sandbox inheritance, and bounded disclosure remain the enforcement mechanisms.

### Child execution

The runtime calls `ctx.subagents.start('spawn', request)`. The spawn provider supplies a fresh child Session with parent workspace and lineage but no parent conversation history. The request carries the root Agent as `parent`, a per-run `AbortSignal`, explicit provider/model overrides when configured, `maxDepth: 1`, a tool allow-list, the Shadow responsibility in the prompt, and an object-rooted output schema.

The default allow-list is `read`, `grep`, and `glob`. Configured extra tools are explicit capabilities, not claims that a tool is read-only. `toolFilter` removes disallowed schemas and rejects disallowed execution. The child also inherits the parent's delegated sandbox restriction and the subagent approval policy pinned to `never`; a write-capable Shadow can mutate only where that inherited policy already permits and cannot ask for wider authority.

The output schema contains `status: 'not_relevant' | 'silent' | 'report'` and `content: string`. The child-scoped `structured_output` tool validates the value and concludes the turn. `report` requires non-empty bounded content; the other statuses require empty content. A missing or invalid structured result, non-completed stop reason, timeout, or infrastructure rejection produces diagnostics but never injects partial assistant text into the root Agent.

The runtime always awaits `run.dispose()` after `run.result`, reporting result and disposal failures independently. Plugin disposal first closes report acceptance, aborts every active controller, clears pending batch timers, and then waits for every child to reach quiescence.

### Report delivery

Accepted reports enter one short deterministic batch window. The batcher orders reports by acceptance and concatenates named sections without an additional model call. Before delivery it rechecks root liveness and epoch, then creates one identified user-role message with source kind `shadow-report`, form `relay`, and report metadata containing Shadow id, run id, child Session id, and `capturedThroughSeq`.

A running root receives the batch through `Agent.steer()`, so it is admitted at the nearest safe step boundary. An idle root receives it through `Agent.followup()`, so it opens one ordinary turn. This matches the existing [next-step report ordering](../../implemented/bug-fix/2026-08-17-subagent-report-settlement-ordering.md): normal inbox ordering owns concurrent delivery, and the Shadow runtime creates no parallel mailbox.

The admitted `user/message` is the model-visible and durable record. Runtime diagnostics may use logs and transient UI state; the first implementation adds no new `SessionEventMap` member merely to duplicate lifecycle information already present in subagent events, child Sessions, and the report source.

### Epoch, cancellation, and recursion

Each observed root Agent owns an epoch. A real user inbox insertion, user-originated turn abort, pause command, root disposal, or plugin disposal advances the epoch and aborts its active children. A result is accepted only when its captured epoch still matches, its exact root Agent remains registered, and its run has not been cancelled. Late results are discarded even when cancellation loses the settlement race.

Only Sessions without `parentSession` are observed. Spawned Shadow children and every other descendant are excluded before scheduler state is created, so their tool-bearing turns cannot recursively activate Shadows. One Shadow id may run at most once per root Agent, while distinct root Agents retain independent scheduler state and concurrency limits.

### Headless lifecycle

The headless runner waits for root Agent idleness and then flushes and exits. A Shadow started after `turn/end` would otherwise outlive that interval. When a managed root enters `agent/status: idle` in a composition that provides `headlessStartup`, the runtime synchronously claims the idle phase with `Agent.runMaintenance()` if runs or report batches remain.

Maintenance waits for child result plus disposal and for the report batch to be queued, bounded by the configured drain timeout. Reports arriving during maintenance use `followup()` and latch the next turn. When maintenance releases, the Agent driver processes that turn and the runner's existing `whenIdle()` follows it before flushing. Timeout closes report acceptance, aborts children, awaits quiescence, records a diagnostic, and releases the runner. Web compositions never enter this maintenance path.

### Management and presentation

The runtime registers `/shadow status|pause|resume|toggle`; pause is per root Agent and cancels active runs. Model-facing management tools list, create, update, enable, disable, and delete definitions and read or update scheduler Settings. Every mutation requests approval during the open parent turn and fails without an available approval path. Definition writes are serialized per id and use same-directory temporary creation plus atomic replacement; delete preserves debug logs unless an explicit later operation owns their removal.

Generic tool rendering is sufficient for the management tools. A Web client extension may register a keyed conversation renderer for `shadow-report`, a status panel, and an `Alt+S` shortcut. It reads host projections and invokes host commands; it does not hold scheduler authority or reconstruct state from browser-local events.

## Package topology

`packages/shadow-mind/shadow-mind-runtime` provides `@deepseek-ai/dsh-shadow-mind-runtime`: the host runtime, Settings registration, definition store, scheduler, trajectory projection, child-run ownership, report batching, commands, and the service consumed by management tools.

`packages/shadow-mind/tool-shadow-mind` provides `@deepseek-ai/dsh-tool-shadow-mind`: the model-facing management Consumer over the runtime service and approval capability. Runtime and tool remain separate because deployments may enable autonomous observation without granting the model authority to edit global definitions.

`packages/bundle/shadow-mind` provides the user-installed `@deepseek-ai/dsh-shadow-mind` bundle and its `cordis.patch.yml`. Its manifest declares `dsh.bundle.patch`, so `dsh plugin --profile <name> add @deepseek-ai/dsh-shadow-mind` both installs dependencies and activates the runtime layer. Published artifacts contain built entry points; tarballs produced by `pnpm pack` are the supported local handoff.

An optional `packages/shadow-mind/client-shadow-mind` package may provide Web presentation. It must remain optional and client-safe; the host runtime and headless profile cannot depend on browser services.

## Required subagent model-selection extension

Pi permits a per-Shadow thinking level. DSH model selection already represents provider, model, and optional `reasoningEffort`, but `SubagentStartRequest.agentOptions` currently exposes only provider, model, and maximum output tokens. Creating children outside the subagent provider solely to install reasoning selection would duplicate publication, cancellation, structured-output, and quiescent-disposal logic.

Extend the one-shot subagent start contract with an optional complete model selection and a matching provider capability. The in-process spawn provider installs that selection in the child creation window through the existing model-selection helper; providers that cannot honor it reject before publication. The Shadow runtime requests the capability only when a definition or default selects reasoning effort. This is a subagent Service Definition and Service Provider change, not an agent-loop change, and its public types, subsystem documentation, provider tests, and assembled coverage update together.

Until that extension exists, the runtime must reject a configured `reasoning_effort` rather than ignore it or mutate a global provider default.

## Durability and observability

Every spawn run has a durable child Session under normal DSH persistence. The `debug` field therefore controls additional scheduler diagnostics and UI exposure rather than whether the child history exists. This intentionally favors DSH auditability over Pi's non-debug ephemeral log behavior; a separate ephemeral subagent provider is outside this proposal.

Seeded randomness makes scheduler decisions reproducible in tests and benchmarks. Runtime diagnostics record bounded decision facts without trajectory text, tool arguments, tool output, credentials, or reasoning. The report source and child lineage provide stable correlation without copying the child transcript into the root Session.

## Security

The default tool allow-list is enforced by the child tool runtime, not inferred from names. Adding a mutating tool is an explicit administrator choice and does not add cross-agent file locking; parallel writers may conflict in the shared workspace. The default remains read-oriented, and the management UI warns when a definition grants tools outside that set.

Trajectory projection is a disclosure boundary. Redaction happens before model-provider selection is invoked, bounds apply to the complete framed prompt, and diagnostics never echo rejected content. Context overflow fails the run with a bounded diagnostic rather than truncating an arbitrary event or relying on Pi's character-count token estimate.

## Alternatives considered

**Modify `agent-loop` to own heartbeat scheduling.** Rejected because eligibility, probability, specialist definitions, and report batching are optional product behavior that existing Session and Agent events already expose. Loop ownership would make one policy part of every Agent and require an architecture update without adding a missing primitive.

**Use continuable subagents for persistent Shadow memory.** Rejected because the observed trajectory is the explicit input and every activation must be independently reproducible. Persistent child history creates stale hidden state, consumes context across unrelated epochs, and turns cancellation into conversation lifecycle management.

**Use the existing child `report` tool.** Rejected because that tool is deliberately scoped to continuable children, may report multiple times without ending a turn, and derives a live direct parent from continuation state. Shadow work is a one-shot result; structured output provides the required terminal and schema-validated result without widening the report tool's authority.

**Create and drive child Agents directly.** Rejected because the spawn provider already owns fresh-session publication, lineage, policy inheritance, tool restriction, structured output, cancellation, result normalization, and quiescent disposal. A second driver would duplicate the most failure-prone lifecycle code.

**Store definitions inside one Settings array.** Rejected because each responsibility is independently authored Markdown, needs file-level diagnostics and atomic updates, and should remain reviewable without rewriting an entire settings document. Settings owns scheduler configuration; the definition directory owns named entities.

**Deliver reports only as transient UI notifications.** Rejected because the root model acts on report content. A model-visible input must be reconstructable from the root Session log, while transient UI state cannot satisfy replay or headless execution.

**Always block the root until Shadows finish.** Rejected for Web sessions because opportunistic review must not delay the user's current turn. Headless uses bounded maintenance only after the root becomes idle, where process exit otherwise destroys accepted background work.

## Acceptance criteria

- Installing the bundle into a profile activates it through `dsh.bundle`; removing it removes both the dependency and patch layer without editing the base bundle.
- With no definitions, the runtime starts no child and changes no model-visible transcript.
- A deterministic assembled scenario proves `tool/result` plus `turn/end` can activate a fresh spawn child, capture structured `report`, append one durable root relay, and produce the root's response to it.
- Pure text turns, model-filter misses, disabled definitions, active duplicate ids, failed probability samples, exhausted slots, and descendant Sessions start no child.
- New user input, user abort, pause, root disposal, plugin disposal, and HMR discard stale reports and await child quiescence without orphaned work or late UI mutation.
- The default child sees only `read`, `grep`, `glob`, and its child-scoped `structured_output`; disallowed tools are absent from prompt and execution.
- Trajectory tests prove reasoning and raw tool output are absent, unknown tools disclose no preview, argument redaction is default, `capturedThroughSeq` excludes later events, and complete-prompt bounds fail closed.
- Headless coverage proves the runner waits through maintenance for one accepted report turn and releases after bounded timeout when a child does not settle.
- Settings, definition parsing, probability sampling, slot selection, epoch checks, batch ordering, and atomic management writes have focused unit coverage, including invalid boundary inputs.
- The product-visible behavior has a real Loader composition test and keyless snapshot. Web-specific behavior, when included, has Web tests and a GIF recorded from the real PR server and model flow.
- Package READMEs, public JSDoc, subsystem documentation for any subagent type change, generated catalogs, bilingual counterparts, and this Agent Note describe the shipped behavior in the same change.

## Risks

Probabilistic activation increases model usage and can amplify turns when several reports arrive. Explicit probabilities, per-root concurrency, one batch window, deterministic seeds, and a pause command bound but do not remove that cost.

Shared-workspace children can race the root or one another when administrators grant mutating tools. The first version provides no cross-Agent transaction or file lock and must say so in configuration and package documentation.

Prompt injection remains possible through trajectory text. Redaction, framing, fresh context, tool restriction, inherited sandbox policy, and non-interactive child approval limit impact but do not make untrusted content safe.

Always-persisted child Sessions consume more storage than Pi's default temporary sessions. Retention follows the existing Session persistence policy; `debug: false` is not a deletion promise.

The model-selection extension widens the subagent start contract and requires every provider to declare whether it supports the option. Capability validation prevents silent degradation, but remote providers remain unavailable for definitions that require unsupported per-run reasoning selection.
