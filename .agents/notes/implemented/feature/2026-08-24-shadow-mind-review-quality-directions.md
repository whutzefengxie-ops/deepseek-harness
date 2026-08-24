# Agent Note: Shadow Mind review-quality mechanisms

Status: implemented

English | [中文](2026-08-24-shadow-mind-review-quality-directions.zh.md)

## Problem

Probabilistic one-shot reviewers can produce useful findings, but free-text prompts, independent sampling, and free-text reports do not expose whether a run targeted a known failure class, cited a visible claim, repeated an earlier finding, shared the root model’s vendor, contradicted another reviewer, or exhausted a reasonable Session budget. Adding more reviewers without those controls increases cost and relay volume without making the output easier to audit.

The useful mechanisms from the ouroboros review lineage are small and separable: concrete probe classes, zero-model-cost filters, anchored report metadata, stateless repetition detection, honest vendor labels, triggered conflict synthesis, holdout discipline, and first-class cost limits. They belong on the existing Shadow scheduler, registry, batcher, and lifecycle instead of introducing another workflow engine.

## Decision

Shadow Mind implements eight review-quality directions over the existing fresh-child orchestration. All runtime thresholds and routes are validated settings or definition fields. Plain definitions keep behavior-preserving defaults, while the starter library opts into the mechanisms it needs. The integrated architecture and ownership boundaries are recorded in [Shadow Mind target architecture](2026-08-24-shadow-mind-target-architecture.md); run conditioning is recorded separately in [Shadow Mind review conditioning](2026-08-24-shadow-mind-review-conditioning.md).

## D1: Probe-class library

`PROBE_CLASSES_V1` is the source of truth for six trajectory-oriented classes: failed tool call, redacted arguments, stale read, misleading success, repeated failure, and long output. Each entry provides a stable id, name, trigger, and concrete probe. `renderProbeChecklist()` produces the prompt block.

The shipped `packages/shadow-mind/shadow-mind-runtime/examples/shadow-minds/` library contains contrarian, hacker, researcher, simplifier, and architect definitions. Each definition names a persona responsibility, embeds the generated checklist, requires an evidence gap instead of a claim that an unobserved probe ran, and asks for the anchored report envelope. The library is opt-in example content and is never loaded automatically into a Harness home.

## D2: Deterministic predicates

The predicate registry has separate skip and boost maps over durable events. Skip predicates are `last-report-covers`, `tool-failure`, and `no-tool-calls`. Boost predicates are `misleading-success`, `repeated-failure`, and `long-output`. Definitions select them through `pre_filter`, `boost_filter`, and `boost_factor`; unknown ids reject the file.

Skips happen after candidate selection and before spawn, increment `prefilterSkips`, and append metadata-only debug output when requested. A boost multiplies activation probability before sampling and clamps the result to one. `tool-failure` is an explicit skip for generic reviewers because the root already saw the error; `misleading-success` and `repeated-failure` remain targeted boost signals for reviewers designed to investigate those patterns.

## D3: Anchored report envelope

A terminal report requires `verdict: 'challenge' | 'gap' | 'confirm' | 'uncertain'`. Optional `severity` is finite from zero through one. `refs` contains at most eight positive, sorted, unique Session sequences present in the exact projected window. Quiet and irrelevant results carry neither content nor envelope fields.

Accepted relay provenance carries verdict, severity, refs, and optional synthesis replacement ids. Route and vendor independence remain process-local status and debug metadata rather than model-visible history. Relay sections sort by severity descending. These fields are optional on durable provenance and the `shadow-report` event remains ignorable, so `SESSION_FORMAT_VERSION` stays `0`.

## D4: Stagnation and novelty

The process-local review window retains bounded metadata, never report text. It detects per-definition spinning from repeated identical envelopes, oscillation from alternating verdicts over identical refs, no-drift from repeated identical confirmations, and diminishing novelty from the configured unique-envelope share.

Detection installs a wall-clock `cooldownUntil`. With escalation enabled, oscillation instead reserves the next available entry in `reasoningEffortLadder` for one run before the definition cools down. Status exposes cooldown expiry and pending escalation. A real user message resets suppression and decay; headless operation relies on wall-clock expiry and escalation because no user message may arrive.

## D5: Reviewer independence

`vendorFamily()` resolves positively known provider prefixes and model markers. `resolveIndependence()` returns `independent`, `same_vendor`, `unverified`, or `unavailable`; unknown routes never imply independence. The label and resolved route appear in terminal status and metadata-only debug records.

`preferIndependentVendor` defaults off. When enabled, same-vendor candidates are removed only when at least two non-same-vendor candidates remain. The viability floor favors a usable jury over a misleading purity claim.

## D6: Conflict synthesis

Within one accepted batch, reports conflict when one verdict is `challenge`, the other is `confirm`, and their refs overlap or either side has no refs. At most one pair is selected: the smallest severity gap wins, followed by the largest combined severity. Synthesis is disabled by default and requires an enabled definition whose id is `synthesizer`.

The additional fresh child receives only the two already-redacted report texts, their verdicts, severities, refs, and the synthesizer instructions. The prompt states that it has not re-verified either report. A valid `challenge`, `gap`, or `confirm` result replaces the pair, carries the weaker input severity, and records both `replacesRunIds`. The original entries remain visible as bounded recent metadata.

Every failure is open: missing definition, prompt overflow, hard-budget exhaustion, invalid or quiet output, timeout, cancellation, provider or disposal failure, or an epoch change forwards both originals unchanged. Metadata-only `logs/synthesizer.jsonl` records the attempt or reason without prompt or report text.

## D7: Holdout discipline

A definition opts in with `holdout: true`. Its unique non-empty literal keys come from owner-only `$DSH_HOME/shadow-minds/holdout-keys.json`; a missing or empty entry rejects the run. Keys are absent from definition files, authoring types, tools, Remote data, browser forms, provenance, status, and debug output.

Literal replacement covers the root trajectory projection, framed child prompt, accepted report text, synthesis prompt, and durable relay. The relay invariant checks owner-known keys before persistence. The mechanism does not confine filesystem reads, alter ordinary child Session persistence, or detect paraphrases, so it supplements rather than replaces sandbox and disclosure policy.

## D8: Session budget and stale-report decay

Per-root `spentChars` counts each admitted prompt and accepted report. An optional soft limit requires both a larger hard limit and `frugalShadowModel`; reaching it routes later eligible runs to that model. Reaching the hard limit stops new Shadow and synthesis work without cancelling admitted runs. Status reports `standard`, `frugal`, or `exhausted`.

When an accepted envelope repeats, its definition’s activation probability is multiplied by `1 - staleReportDecay` for later turns. The default zero disables decay. A real user message resets spend and decay together with cooldown and escalation state.

## Alternatives considered

**Mount the ouroboros runtime as a dependency.** Rejected because it brings a separate workflow and process model. Harness-owned modules use the existing Session, subagent, settings, and lifecycle seams and are verified by this repository’s gates.

**Ship only prompt examples.** Rejected as the complete design because predicates, durable anchors, repetition, vendor labels, synthesis provenance, holdout handling, and budgets require runtime state and validation. The probe library remains content-only within the larger design.

**Assign a numeric quality score to every root turn.** Rejected because there is no ground truth for such a score. Anchored verdicts and diagnostic challenge outcomes expose auditable facts without pretending to measure correctness directly.

**Prefer independence even when one reviewer remains.** Rejected because a single reviewer is not a viable conflict set. The filter applies only when two non-same-vendor candidates survive.

**Make synthesis mandatory.** Rejected because it adds cost and can fail or distort both inputs. It is opt-in, handles one pair, and preserves deterministic fail-open delivery.

**Store holdout keys in frontmatter.** Rejected because definitions, management APIs, and browser forms are root-readable surfaces. The owner-side sidecar keeps literals out of those paths while stating its limited protection honestly.

## Verification

Pure tests pin the probe rendering and five shipped definitions, every predicate and threshold, envelope normalization and invariant rejection, all four stagnation patterns, vendor classification and viability floor, conflict pair ordering, synthesis prompt bounds, literal replacement, budget transitions, and stale decay. Runtime integration tests cover debug and value-loop journals, same-vendor filtering, cooldown and escalation, frugal and hard budgets, successful replacement, every synthesis fail-open class, holdout redaction across prompts and relays, cancellation epochs, and resource disposal. Management and browser tests pin every new definition, settings, and status field while proving holdout keys have no management surface. A keyless assembled snapshot pins the model-visible probe, envelope, synthesis, and relay contracts.

## Consequences

Review activity becomes observable and bounded: operators can tell why a definition ran, skipped, decayed, cooled down, changed route, or invoked synthesis. Anchors allow deterministic validation and comparison, vendor labels avoid false independence claims, and fail-open synthesis never hides both original findings.

The mechanisms increase configuration and process-local bookkeeping. Probe matches and challenge classifications remain heuristics, severity is comparable only within a relay, vendor tables can become unverified, and character budgets approximate cost rather than tokens or currency. Holdout replacement protects only exact literals on owned model-visible paths. Conservative defaults keep vendor filtering, decay, budgets, escalation, synthesis, and holdout opt-in; all diagnostic files omit trajectory and report text.
