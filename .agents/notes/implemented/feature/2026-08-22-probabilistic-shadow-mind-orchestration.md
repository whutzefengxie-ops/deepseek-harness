# Agent Note: Probabilistic Shadow Mind orchestration

Status: implemented

English | [中文](2026-08-22-probabilistic-shadow-mind-orchestration.zh.md)

## Problem

Pi Shadow Mind runs specialized background reviewers after tool-using turns and returns useful findings to the main agent without requiring the user to start each review. DeepSeek Harness has the lifecycle, durable Session log, subagent, settings, approval, and profile-bundle mechanisms needed for the same product behavior, but it had no installable composition that connected them. Reimplementing Pi's private session driver inside a plugin would duplicate subagent publication, cancellation, policy inheritance, structured output, and quiescent disposal.

The feature also crosses a data-disclosure boundary. A Shadow can use another model provider, so blindly copying the main transcript, hidden reasoning, tool arguments, or raw tool output would expand what leaves the root provider. Background work can outlive the turn that triggered it, so a late report can become stale after new user intent. A headless process can exit while work or a report batch is still pending. The implementation must therefore make capture, disclosure, cancellation, delivery, and shutdown explicit.

## Decision

Shadow Mind is an optional plugin family installed through the profile bundle `@deepseek-ai/dsh-shadow-mind`. The bundle mounts a root-only orchestration service and a separate management-tool plugin. It observes existing Session and Agent extension points; `dsh-agent-loop` remains unchanged.

After a completed root turn with at least one durable `tool/result`, the runtime evaluates one heartbeat. Every enabled, model-eligible definition then performs its own activation draw. If the hits exceed available per-root slots, Fisher–Yates sampling chooses an unbiased subset; otherwise the runtime preserves catalog order and consumes no selection draws. Each selected definition starts a fresh one-shot `spawn` subagent, receives a bounded reasoning-free projection of the captured root log, and must finish with structured status. Accepted reports are batched and appended to the root as durable user-role messages.

## Pi Shadow Mind reference behavior

The reference ZIP contains `pi-shadow-mind` version `0.1.14`. It evaluates only a main-agent `turn_end` that contains tool results. Its default heartbeat is `1/3`, each Shadow defaults to activation probability `0.3`, and at most two Shadows run concurrently. Eligible definitions draw independently; Fisher–Yates chooses among excess hits. Model filters accept `*` or an exact full `provider/model` string.

Each Pi run creates a fresh Session. `debug: false` uses an in-memory Session; `debug: true` writes a Session log. The child inherits the main system prompt and receives a serialized trajectory with assistant thinking removed. Its default tools are `read`, `grep`, `find`, and `ls`, plus `report_to_main`. Pi preserves tool arguments. Known file tools summarize line counts and a first-line preview; unknown tools do not expose a text preview. An irrelevant reviewer emits the exact `NOT_RELEVANT` sentinel; an actionable reviewer calls `report_to_main`, which terminates the run.

Pi supports per-Shadow model, thinking level, timeout, debug, definition/configuration tools, `/shadow`, `Alt+S`, a status panel, and a message renderer. Mutating management actions require UI confirmation. New user input, pause, or shutdown cancels active runs and drops pending reports. Print/JSON headless shutdown waits for active runs, report batches, message delivery, and main-agent idle state.

## Definitions and settings

Global definitions live at `$DSH_HOME/shadow-minds/*.md`. YAML frontmatter owns `id`, `name`, `enabled`, `debug`, `activation_probability`, `active_for_models`, `run_with_model`, `reasoning_effort`, `timeout_seconds`, and `tools`; the Markdown body is the review responsibility. DSH uses `reasoning_effort` because model adapters already expose that selection. Unknown fields and conflicting or malformed values fail instead of being adapted implicitly.

The registry loads files in deterministic path order and isolates each read, YAML, validation, and duplicate-id failure. The first valid definition wins an id. Creates and updates validate before atomic owner-only writes and serialize operations per id; definitions with different ids may change concurrently. Delete preserves the definition's opt-in JSONL debug log. Debug records contain fixed run identity, capture, stop, status, and error facts, not trajectory content.

The live `shadow-mind` settings namespace owns heartbeat probability, per-root concurrency, default timeout, headless drain timeout, batching window, optional default model and reasoning effort, argument disclosure, deterministic random seed, complete prompt limit, and report limit. Invalid `provider/model` defaults fail during schema validation. Definitions remain named Markdown entities rather than a settings array because they need file-local diagnostics, reviewable responsibilities, and independent atomic writes.

## Scheduling, capture, and cancellation

Only Sessions without `parentSession` are observed, so Shadow children and every other descendant cannot recursively trigger this runtime. One Shadow id runs at most once per root at a time. Different roots own independent epochs, active maps, slot limits, report batchers, and maintenance state.

The capture watermark is the triggering `turn/end` sequence. The projection includes user text, visible assistant text, tool names, policy-selected arguments, deterministic tool-result metadata, compaction summaries, and earlier durable Shadow relays. It excludes assistant reasoning, stream chunks, raw tool-result text, unrelated diagnostics, and later events. The default argument policy is `redacted`. Known `read`, `grep`, and `glob` results expose counts and character size without previews; unknown tools expose only success or failure, content kinds, and bounded sizes. The complete framed prompt fails closed above `maxPromptChars` instead of cutting an arbitrary event.

New real user input, user cancellation, pause, root disposal, plugin disposal, and headless drain timeout advance the root epoch and abort every active run. A result is accepted only while its captured epoch still matches, the exact root is still registered, and scheduling is active. This rejects late results even when cancellation loses a settlement race. Capacity remains occupied until `run.result` and `run.dispose()` both settle.

## Child execution and model selection

The runtime calls `ctx.subagents.start('spawn', request)` with the root as parent, `maxDepth: 1`, a per-run signal, the prompt, an allowlist, structured output, and optional model selection. The default allowlist is `read`, `grep`, and `glob`; definition tools add explicit capabilities and are not presumed read-only. Tool restriction removes denied schemas and rejects denied execution.

In-process delegation inherits the parent's explicit sandbox override and appends an `approval/policy` event fixed to `never` when approval is composed. A Shadow cannot ask to widen authority. Adding a write-capable tool still permits modifications already allowed by the inherited sandbox, and parallel writers have no cross-agent transaction.

The one-shot subagent start contract carries optional complete `modelSelection`, and `SubagentCapabilities.modelSelection` declares provider support. The service rejects unsupported selection and conflicting `agentOptions` with `CONFLICTING_MODEL_SELECTION`. Spawn and fork in-process providers install provider, model, and reasoning effort during child creation. This extension keeps Shadow orchestration on the existing provider lifecycle instead of constructing and driving an Agent directly.

The object-rooted output schema carries `status: 'not_relevant' | 'silent' | 'report'` and `content: string`. The child-scoped `structured_output` tool validates the JSON schema and concludes the turn; the runtime additionally enforces that reports are non-empty and other statuses use an empty string. Report text is trimmed and bounded. Missing or invalid structured output, non-completed stop reasons, timeout, provider failure, and disposal failure produce diagnostics but never inject partial assistant text into the root.

## Durable report delivery and shutdown

Accepted reports enter an ordered fixed-window batch. Delivery rechecks root identity and epoch, then creates a `user/message` whose source is `{ kind: 'shadow-report', form: 'relay' }`. Provenance aligns each section with its Shadow id, run id, child Session id, and capture watermark. A running root receives the message through `steer()` at the next safe step boundary; an idle root receives it through `followup()`. The ordinary inbox owns concurrent ordering, and the durable message makes later model requests reconstructable from the Session log.

The report batcher exposes a quiescence barrier and retains asynchronous delivery failures for that barrier instead of swallowing them. Root disposal and plugin disposal share one release promise per owner. Release waits for schedules, run results, child disposal, batch flush, and delivery; independent cleanup failures are aggregated and the owner entry is removed in every outcome.

When `headlessStartup` is present, an idle root with admitted Shadow work calls `Agent.runMaintenance()`. Maintenance holds the runner until schedules, children, batches, relays, and resulting follow-ups converge. Timeout aborts work and still waits for quiescence. Web compositions do not claim this interval.

## Administration and package topology

`packages/shadow-mind/shadow-mind-runtime` provides `@deepseek-ai/dsh-shadow-mind-runtime`, `ctx.shadowMind`, definition persistence, settings, scheduling, projection, child ownership, batching, `/shadow` state methods, and the durable report invariant. `packages/shadow-mind/tool-shadow-mind` provides `@deepseek-ai/dsh-tool-shadow-mind`, registers `/shadow status|pause|resume|toggle`, and contributes eight model tools for listing, creating, updating, enabling, disabling, deleting, reading settings, and updating settings. Mutations require the exact `allowed-once` approval outcome. Keeping these packages separate permits runtime-only deployments without model editing authority.

`packages/bundle/shadow-mind` provides the installable `@deepseek-ai/dsh-shadow-mind` patch layer. `dsh plugin --profile <profile> add @deepseek-ai/dsh-shadow-mind` records the dependency and bundle in the selected profile; the patch mounts runtime before administration. The delivered composition uses generic tool and command presentation. It does not include Pi's dedicated Web panel, renderer, or `Alt+S` shortcut.

## Differences from Pi

DSH intentionally uses its existing `read`, `grep`, and `glob` tools instead of Pi's `read`, `grep`, `find`, and `ls`. Arguments are redacted by default, and no known or unknown tool result includes a first-line preview. Structured terminal output replaces the `NOT_RELEVANT` sentinel and `report_to_main`. Model eligibility accepts local `*` and `?` globs against model ids or full routes, which is broader than Pi's exact full-route rule. Child Sessions follow DSH persistence policy instead of switching to memory when debug is false. Management uses generic DSH approval, tools, and commands rather than a dedicated UI.

## Alternatives considered

**Put heartbeat scheduling inside `agent-loop`.** Rejected because probability, specialist definitions, disclosure, and batching are optional product policy fully expressible through existing Session and Agent events.

**Reuse a continuable subagent as persistent Shadow memory.** Rejected because every activation must be reproducible from the explicit capture; hidden child history would cross epochs, consume context, and turn cancellation into session-lifecycle management.

**Use the continuable child `report` tool.** Rejected because that tool supports repeated non-terminal handbacks and direct continuation-parent semantics, while a Shadow produces one terminal structured result.

**Create and drive child Agents directly.** Rejected because the spawn provider already owns publication, lineage, delegated policy, tool restriction, model selection, structured output, cancellation, result normalization, and quiescent disposal.

**Store definitions in one settings array.** Rejected because independent Markdown responsibilities need per-file diagnostics, stable names, atomic writes, and review without rewriting an unrelated settings document.

**Deliver reports only as transient UI notifications.** Rejected because report content affects later root requests and must be reconstructable from the durable Session log in Web and headless compositions.

## Verification

Pure tests cover definition parsing and atomic mutation, settings validation, model globs, heartbeat and unbiased slot selection, deterministic random seeds, trajectory disclosure, compaction summaries, prompt bounds, fixed-window batching, delivery failures, and report provenance. Real AgentLoop plus in-process spawn coverage proves a tool-using root turn starts a fresh child, applies the selected model and delegated `never` approval, captures structured output, persists a root relay, drives the follow-up response, and withholds raw arguments and tool results. Cancellation coverage proves new user intent aborts active work and blocks stale relay. Concurrent root/plugin disposal coverage pins the shared quiescent release.

The management package coverage proves Loader-compatible named exports, eight tool and command registrations, HMR disposal, refusal without mutation, and `allowed-once` create, update, enable, disable, delete, and settings writes. The bundle composition test parses the shipped `cordis.patch.yml` through the real Loader and activates both packages. A keyless assembled snapshot pins the complete root-tool, child-report, durable-relay, follow-up, and headless-convergence transcript.

## Consequences

Probabilistic review adds conditional model requests, report tokens, child Session storage, and possible latency after a tool turn. Heartbeat, independent activation, model filters, per-root slots, timeouts, prompt/report bounds, pause, batching, and deterministic seeds bound or reproduce the cost but do not remove it.

Default disclosure is stricter than Pi and may reduce reviewer context. An administrator can opt into full arguments or extra tools, accepting the provider-disclosure and shared-workspace race consequences. Fresh children avoid stale hidden state and recursive scheduling at the cost of repeated prompt context. Durable relays and child Sessions improve replay and auditability at the cost of storage. Generic presentation keeps the plugin usable in headless and Web profiles but gives up Pi's dedicated status panel and shortcut.
