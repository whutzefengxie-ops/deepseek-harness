# Agent Note: Shadow Mind review conditioning

Status: implemented

English | [中文](2026-08-24-shadow-mind-review-conditioning.zh.md)

## Problem

Fresh Shadow children receive a bounded projection of the root log, but three execution details determine whether that projection remains useful. Complete-history projection grows until it reaches the prompt limit even after compaction has replaced older model-visible history. Ordinary child composition can inject runtime context and pre-step additions unrelated to a narrow review. A tool catalog on the first request lets the child attempt its terminal structured result without first naming which durable claims it intends to investigate.

These are conditioning problems rather than new reviewer identities or scheduling rules. They must use the existing one-shot subagent seam, preserve policy enforcement and fresh-child reproducibility, and reject unsupported provider behavior instead of silently degrading.

## Decision

Every Shadow definition has three conditioning fields with behavior-preserving defaults: `capture: 'full' | 'since-compaction'` defaults to `full`, `context: 'standard' | 'minimal'` defaults to `standard`, and `thinkFirst: boolean` defaults to `false`. The registry, authoring API, management tools, Remote administration, browser form, serialization, and status diagnostics use the same vocabulary.

The runtime also records `deliberationChars`, the child text and reasoning characters emitted before the structured-output tool call. This metric is process-local diagnostic data and never decides acceptance, scheduling, escalation, or budgets.

## Compaction-epoch capture

`projectTrajectory(events, capturedThroughSeq, disclosure, capture)` renders only durable events at or below the capture watermark. In `since-compaction` mode it finds the latest `compaction/end` in that range and excludes ordinary events at or before that boundary while retaining `compaction/summary` events. Without a boundary, output is identical to `full`.

Every projected output line begins with the source event sequence. Report `refs` are validated against the set of sequences included in that projection, not merely against the capture watermark. Prompt-size validation still applies to the complete framed prompt and fails rather than truncating an event.

## Minimal child context

The one-shot subagent request adds `contextInheritance?: 'standard' | 'none'`, paired with `SubagentCapabilities.contextInheritance`. The service rejects a non-standard request when the selected provider does not declare support. Shadow Mind maps `context: minimal` to `contextInheritance: 'none'`.

The in-process driver applies the policy during child composition. It claims the caller’s initial prompt batch and suppresses other model-visible dynamic context and pre-step additions for that child. Sandbox policy, approval policy, delegation scope, lifecycle observers, persistence, and other non-model enforcement remain installed. The option is not a sandbox mode and does not reduce filesystem access by itself.

## Think-first execution

The one-shot request adds `thinkFirst?: boolean`, paired with `SubagentCapabilities.thinkFirst`. Unsupported providers reject the option before start. Spawn in-process composition supports it; fork exposes the capability only where it can preserve the same semantics.

With think-first enabled, the child’s effective tool restriction is empty for its first model request. The framed prompt requires a numbered plan naming the rendered sequence anchors it intends to challenge or verify. After the first durable assistant message, the provider steers exactly one continuation that opens the configured tool directory and asks the child to investigate and submit the structured verdict. Both steps share one `SubagentRun`, cancellation signal, deadline, result, and dispose barrier.

The first response is not accepted as the Shadow result. Missing first output, cancellation, failure, or disposal prevents the continuation or settles the run through the ordinary stop reason. The second step remains subject to the structured-output schema and the same read-only tool and policy constraints as a standard Shadow run.

## Alternatives considered

**Truncate the oldest rendered characters.** Rejected because arbitrary truncation can split an event, remove the claim a later line depends on, and make anchors ambiguous. Compaction already supplies an explicit semantic boundary.

**Remove injections by source-specific denylist.** Rejected because new context contributors would bypass it. The child-scoped inheritance policy acts at the unified model-visible injection paths while preserving enforcement plugins.

**Construct and drive a private child Agent in Shadow Mind.** Rejected because the subagent provider already owns publication, lineage, composition, cancellation, structured output, and disposal. The two capabilities belong on that seam.

**Hide only tool descriptions while leaving execution enabled.** Rejected because tool visibility and execution are one restriction. The first request uses an empty effective allowlist, then one provider-owned continuation restores the requested directory.

**Require minimal context or think-first for every definition.** Rejected because some reviewers need workspace instructions or benefit from a single-step request. Both remain explicit per-definition choices.

## Verification

Trajectory tests pin full and compaction-epoch projection, numbered lines, summary retention, and out-of-window anchor rejection. Subagent service tests pin loud capability rejection. In-process inheritance tests prove minimal context removes dynamic model-visible additions while retaining approval and sandbox enforcement. Spawn tests prove the first request has zero tools, one continuation opens the requested directory, and cancellation or disposal covers both steps. Runtime integration and keyless assembled snapshots pin the framed planning instruction, request sequence, deliberation telemetry, and structured terminal report.

## Consequences

Long compacted Sessions can review the current epoch without carrying raw pre-compaction history. Narrow reviewers can avoid unrelated dynamic context without changing authority. Think-first reviewers spend an additional model step to state their intended anchors before tool use, making the subsequent finding easier to audit.

The defaults preserve one-step full-history behavior. `since-compaction` relies on compaction summaries being adequate, minimal context can remove useful task instructions, and think-first increases latency and token cost. Diagnostic reasoning length can be gamed and has no control authority. Providers must implement the exact capabilities or reject the request, which prevents silent behavior drift at the cost of narrower provider compatibility.
