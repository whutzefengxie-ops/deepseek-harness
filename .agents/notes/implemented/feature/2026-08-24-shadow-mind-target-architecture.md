# Agent Note: Shadow Mind target architecture

Status: implemented

English | [中文](2026-08-24-shadow-mind-target-architecture.zh.md)

## Problem

The shipped [probabilistic Shadow Mind orchestration](2026-08-22-probabilistic-shadow-mind-orchestration.md) supplies fresh background reviewers, bounded trajectory projection, durable relays, and lifecycle ownership. It does not by itself decide which turns deserve additional spend, give findings durable trajectory anchors, distinguish independent reviewers, resolve repeated or conflicting findings, or bound review cost across a Session. The [review-conditioning](2026-08-24-shadow-mind-review-conditioning.md) and [review-quality](2026-08-24-shadow-mind-review-quality-directions.md) mechanism families address different parts of that problem and need one ownership and composition decision.

A persistent “review committee” is the wrong model. Each Shadow run is a fresh stateless child. Filters, cooldowns, budgets, and classifications are deterministic runtime state, while the optional synthesizer receives only the selected reports for one batch. A read-only child with approval fixed to `never` can check consistency with the durable trajectory, but it cannot prove claims about omitted data or inaccessible artifacts.

## Decision

Shadow Mind is a self-managing, anchored-level review pipeline. Deterministic rules decide when to spend; each admitted run receives an epoch-scoped projection and explicit conditioning; every report names an epistemic verdict and optional durable event anchors; deterministic coordination handles repetition, vendor relationship, budgets, and conflict; metadata-only diagnostics measure whether the root acts on challenges. Reports remain independent analysis and never gain authority over the root.

The architecture has five owned layers:

1. The trigger layer owns heartbeat exploration, named skip and boost predicates, effective probabilities, decay, cooldowns, and the Session budget.
2. The run layer owns `capture`, `context`, `thinkFirst`, model routing, tool restriction, approval and sandbox inheritance, and deliberation-character telemetry.
3. The output layer owns `verdict`, `severity`, `refs`, report validation, severity ordering, and durable relay provenance.
4. The coordination layer owns stagnation patterns, vendor-independence labels, one-pair conflict synthesis, fail-open behavior, and replacement provenance.
5. The governance layer owns soft and hard budgets, owner-side holdout literals, process-local status, metadata-only debug journals, and the diagnostic value loop.

## Anchored projection and report semantics

Every rendered trajectory line carries its durable Session sequence. `capture: since-compaction` selects the latest compaction epoch while retaining summaries, so `refs` can name only events the reviewer saw. Reports use `challenge`, `gap`, `confirm`, or `uncertain`; `gap` means required evidence is absent, while `uncertain` means the visible evidence does not support a judgment. Severity orders reports within one relay and breaks synthesis pair ties; it is not a cross-model quality score.

`thinkFirst` explicitly asks for a numbered plan of the rendered sequences the child intends to investigate before tools become visible. The runtime records text and reasoning characters before structured output as diagnostic `deliberationChars`. Length is a gameable proxy and does not gate acceptance or scheduling.

The optional fields added to `shadow-report` provenance are ignorable and do not alter Session log structure. `SESSION_FORMAT_VERSION` therefore remains `0`.

## Deterministic spend and coordination

Named predicates inspect durable events without a model call. Skip predicates reject a selected run; boost predicates multiply activation probability before sampling. The effective per-definition probability is visible in status. Seeded scheduling is reproducible from the same history and settings, not from the seed alone.

The review window detects spinning, oscillation, no-drift, and diminishing novelty. Detection installs a wall-clock cooldown or, when configured, consumes one higher reasoning-effort rung before suppression. A real user message resets cooldown, escalation, probability decay, spend, and pending challenge observations.

Prompt and accepted-report characters accumulate per root. A soft cap routes eligible runs to the configured frugal model; a hard cap prevents new runs without cancelling admitted work. Every threshold and route is validated settings or definition data rather than a plugin constant hidden from deployment configuration.

Conflict synthesis considers at most one overlapping `challenge`/`confirm` pair per batch. A valid synthesis replaces that pair, inherits the weaker report’s severity and epistemic standing, and names the replaced run ids. Missing configuration, prompt overflow, hard-budget exhaustion, invalid or quiet output, timeout, cancellation, provider failure, and disposal failure all forward both originals unchanged and append metadata-only diagnostics.

## Holdout and value-loop boundaries

Holdout keys live only in owner-readable `$DSH_HOME/shadow-minds/holdout-keys.json`, keyed by definition id. The runtime applies literal replacement to the trajectory projection, child prompt, accepted report, synthesis prompt, and root relay. Definitions, Remote responses, UI forms, provenance, and debug journals never contain the keys.

This mechanism is not a filesystem sandbox. Child Sessions follow ordinary persistence policy, child tools retain access allowed by the inherited sandbox, and a model can evade literal matching by rewriting or paraphrasing. Restricted tools, no-disclosure deployment configuration, and prompt discipline remain the enforcement controls.

For each accepted challenge, the value loop observes a configured number of later root turns and classifies durable evidence as `challenge_adopted`, `challenge_rejected`, or `ignored`. Adoption recognizes explicit action language or tool targets that overlap artifacts referenced by the challenged events; rejection requires explicit contradictory language. Process-local counters expose challenge count and hit rate. Owner-only `value-loop.jsonl` stores classification metadata without trajectory or report text. No classifier output gates, tunes, rewards, or suppresses runtime behavior.

## Ownership

This note owns the composed architecture, the five-layer split, the anchored-level claim, holdout boundary, value-loop non-authority, and cross-mechanism ordering. The [conditioning note](2026-08-24-shadow-mind-review-conditioning.md) owns compaction capture, minimal context, think-first execution, and deliberation telemetry. The [quality-directions note](2026-08-24-shadow-mind-review-quality-directions.md) owns probes, predicates, envelopes, stagnation, independence, synthesis, holdout mechanics, and budgets. The original [orchestration note](2026-08-22-probabilistic-shadow-mind-orchestration.md) continues to own the base scheduler, fresh-child lifecycle, disclosure projection, durable batching, administration topology, and Pi comparison.

## Alternatives considered

**Persistent reviewer identities or cross-run memory.** Rejected because every run must be reproducible from its explicit capture; hidden reviewer history would cross cancellation epochs and turn deterministic coordination into another agent lifecycle.

**Describe the result as evidence-grade.** Rejected because the child cannot verify omitted content or inaccessible state. Anchored-level states the actual guarantee: findings can cite the visible durable trajectory.

**Use reasoning length as a quality gate.** Rejected because length can be optimized without improving a finding. It remains telemetry until an independently justified decision introduces a better signal.

**Let challenge classifications tune scheduling automatically.** Rejected because the heuristics are weak and can misclassify silence or coincidental tool activity. Their cost is limited to a diagnostic record.

**Forward conflicts without synthesis.** Retained as the mandatory fail-open path, but not the only path: a configured synthesizer can reduce arbitration work while keeping both originals whenever it cannot produce a valid replacement.

## Verification

Pure tests pin numbered projection, compaction windows, predicate behavior, report-envelope validation, all stagnation patterns, vendor labels, conflict selection and fail-open paths, holdout replacement, budgets, and the fixed value-loop replay corpus. Real AgentLoop and spawn-provider tests pin minimal context, think-first continuation, deliberation telemetry, accepted relays, synthesis replacement, stale-epoch rejection, owner-only journals, and quiescent disposal. A keyless assembled example pins model-visible projection, probe instructions, think-first requests, synthesis prompts, and durable relay provenance.

## Consequences

The runtime spends fewer requests on deterministic low-value cases and exposes why a run was skipped, boosted, downshifted, suppressed, synthesized, or stopped. Anchors and verdicts make reports comparable without claiming proof. Fresh children remain reproducible, and all model-visible inputs and relays remain reconstructable from durable Session data.

The feature adds configuration, process-local state, optional extra synthesis calls, and metadata journals. Minimal context can remove useful instructions, think-first adds a model step, vendor classification can become unverified as providers evolve, and holdout replacement cannot prevent semantic disclosure. Conservative defaults keep conditioning, vendor preference, decay, budgets, escalation, and synthesis opt-in; the value-loop journal is default-on but contains metadata only.
