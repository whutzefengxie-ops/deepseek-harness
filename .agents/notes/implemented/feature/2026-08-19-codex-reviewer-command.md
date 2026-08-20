# Agent Note: Human `/review` command over the local Codex CLI

Status: implemented

English | [中文](2026-08-19-codex-reviewer-command.zh.md)

## Problem

An operator watching a coding agent's session often wants an independent, second-opinion review of what the agent has produced so far — correctness, design, and risks — without spending a turn of the reviewed agent and without the reviewed model grading its own output. Sending "review the conversation" as prompt text would put the review on the same model that produced the work and consume one of its turns. Building admission into a UI surface would duplicate command discovery and command lifecycle logging. The result still needs a dedicated presentation because a long-running review must remain observable and recoverable after the browser request ends.

The review itself is a prompt-and-run job for an external tool. The local Codex CLI already accepts a non-interactive prompt (`codex exec`), carries its own model selection, reasoning-effort (`model_reasoning_effort`) and sandbox configuration, and can be driven entirely through stdin plus flags — no shell interpretation of conversation text is needed. Keeping the run inside the browser Remote leaves the composer submitting until Codex exits and lets refresh cancel the process through that request's signal. An auxiliary process also needs explicit elapsed-time and output bounds. The reviewer therefore needs a durable lifecycle, Agent-owned cancellation, process-tree teardown, and resource limits.

## Decision

### `/review` is a host-plane command over the subprocess seam

`@deepseek-ai/dsh-command-reviewer` registers the global human command `/review` (审查者) through `ctx.commands` and requires `ctx.subprocess`. The handler projects the receiving session's derived messages into a plain-text transcript (`renderTranscript`: conversational text, tool calls, and tool results, excluding request-configuration context, reasoning, and images), assembles the review prompt, and spawns one non-interactive run:

```text
codex exec --json --color never --ephemeral --skip-git-repo-check -s <sandbox> [-m <model>] -c model_reasoning_effort=<effort>
```

The prompt crosses the subprocess seam as batch stdin, so no conversation text ever enters argv or a shell boundary. Each run wraps the transcript in a delimiter containing a fresh UUID and tells Codex to treat its contents only as untrusted review evidence, not as instructions. The projection excludes semantic instruction, catalog, and runtime-snapshot context instead of presenting request configuration as user dialogue; direct messages, model output, tool activity, notices, relays, recalls, compaction summaries, and unknown extension forms remain evidence. The active subprocess provider resolves the canonical Codex path in its execution world, and that path becomes `argv[0]`. If it is a Windows `.cmd` or `.bat` wrapper, the same provider resolves `cmd.exe`; argv uses `/d /q /v:off /s /c` to expand `DSH_CODEX_REVIEWER_EXECUTABLE`, whose explicit child-environment value is the quoted canonical wrapper path. Paths containing spaces or command metacharacters therefore remain one executable token. The configurable model is restricted to a portable identifier before the interpreter receives it. The Codex CLI itself must be installed and authenticated in the provider's execution world. The run executes in the session's working directory (the process directory when the session carries none), with `read-only` as the default sandbox. Stdout is streamed JSONL; the decoder records public Codex phases and safe item summaries and extracts the final `agent_message` text.

The handler reads every section field per invocation, so settings edits apply live. It atomically reserves one of the Agent's configured review slots before executable resolution, preserving the subprocess provider's diagnostic when admission fails. Immediately before appending `review/start`, it calls `invocation.commit()` to transfer settlement ownership from the browser request to the durable lifecycle. The start record contains the exact prompt, canonical argv, explicit child-environment entries, working directory, and elapsed timeout; a browser abort before the commit prevents the append, while an abort after it cannot turn the admitted command into an error `command/done`. The handler spawns the process with an Agent-owned controller and deadline and immediately returns a successful `sourceEventSeq` acknowledgement. Normal completion terminates any residual descendants; timeout, Agent teardown, and plugin teardown terminate the process tree. Every terminal path confirms whole-tree exit before recording `review/end` and releasing the Agent slot. A failed exit confirmation leaves the review open and owned, logs the background failure, and makes teardown report the failure instead of claiming quiescence.

### Durable events own progress and refresh recovery

The log-only lifecycle is `review/start` → zero or more `review/activity` → `review/end`, correlated by the executor-minted `commandId`. Activities preserve Codex item identity and started/completed state while projecting only safe categories and summaries; reasoning content is not recorded. Completion, structured failure, malformed JSONL, output overflow, nonzero exit, signal termination, and owner cancellation all settle through `review/end` rather than a generic Remote abort. Orthogonal structured and process failures are combined so neither diagnostic is lost. On `agent/session-start`, the plugin scans the resumed Session for starts without ends. For each open review, it first appends the successful `command/done` anchored to `review/start` when the command acknowledgement is missing, then appends one `interrupted` terminal record; a second startup edge finds both lifecycles closed and appends nothing.

`@deepseek-ai/dsh-client-ui-reviewer` folds this family into one Chat node and renders the final Markdown. Refresh replays the same running or terminal state, and Host recovery renders the appended terminal record as `Interrupted`; a page containing only mid-run activity or the terminal event reconstructs the card with an empty focus until the page containing `review/start` arrives. `command/done.sourceEventSeq` points at `review/start`; the Chat projection suppresses the generic command row only when a visible non-command Chat node actually has that anchor. Deployments without the reviewer presentation therefore retain the generic result. The lifecycle invariant checks the `/review` command identity, focus, request fields, and exact `command/done` source relation. No synthetic percentage is used.

### The `command-reviewer` settings section owns every tunable

The plugin registers the `command-reviewer` settings namespace (base layer = composition entry) with the schema: `enabled` (the card's switch; the command refuses while off), `model` (empty or a portable identifier containing only letters, digits, `.`, `_`, `:`, `/`, `@`, `+`, and `-`), `thinkingEffort` (`low|medium|high`), `sandbox`, `prompt` (a `{transcript}` placeholder marks where the conversation goes; without one the transcript is appended), `context` (deployment-level scenario supplement), `maxTranscriptChars`, `maxOutputBytes`, `terminateGraceMs`, `timeoutMs`, and `maxConcurrentReviews`. Timer values are bounded by the Node maximum; the default elapsed timeout is 30 minutes and the default per-Agent concurrency limit is one. `maxOutputBytes` defaults to 8 MiB so repository inspection can carry command output while runaway processes remain bounded. `@deepseek-ai/dsh-client-ui-settings-plugins` renders the 审查者 (Reviewer) card in the Plugins settings page — the same card surface as Shell, Agent loop, and Web search — with a toggle, selects for effort and sandbox, and text areas for prompt and context. The card validates the model identifier before save, uses field-specific invalid-value copy, and warns that writable sandbox modes grant their permissions to transcript-driven review commands. A card renders nothing when the deployment does not compose the owning plugin.

### The command stays out of the reviewed agent's model stream

The review is an auxiliary process, not a harness LLM request. The command pair and all `review/*` events remain log-only; neither the built prompt, the Codex run, nor the review text reaches the reviewed agent's request. The conversation transcript is the only session data read, and it is bounded by `maxTranscriptChars` (tail-keep with a truncation header).

## Alternatives considered

### Why not a model tool?

A tool named `review` would be callable by the reviewed model itself, spending its own turns and grading its own work; the user asked for an operator-facing command. A command keeps the invocation human-only and off the model surface.

### Why not `codex exec review`?

The built-in review subcommand reviews the working repository, not the agent's conversation; the review target here is the transcript. The prompt-building path (`codex exec` + stdin) keeps the payload fully under this plugin's control.

### Why not reusing the `subagent-codex` app-server provider?

The app-server protocol is a long-lived stdio wire owned by the subagent capability; a one-shot review needs none of its thread/turn machinery, and composing the subagent seam would make the review a delegation instead of a command. Plain `codex exec` is the smallest process boundary that serves the prompt.

### Why not a dynamic plugin?

The command must appear in the shipped settings surface, keep durable settings, and survive restarts; a composition-mounted static package is the only form the Plugins settings page and the plugin inventory understand.

### Why not a generic background job?

The ordinary job surface can report unconsumed owner-job completion back into the reviewed Agent. A review must stay outside that model stream, so the reviewer owns its background lifecycle directly and binds cleanup to the Agent context.

## Consequences

- **An auxiliary Codex run per invocation** — one fresh non-interactive process per `/review`; there is no session reuse, and the review cannot be continued from inside the command.
- **Transcript-only review surface** — instruction, catalog, and runtime-snapshot context, reasoning blocks, images, and attachments are not forwarded; the review sees conversational text, tool calls, and tool results.
- **Codex presence is a host responsibility** — an executable-resolution failure blocks admission with the subprocess provider's diagnostic; authentication, JSONL, exit-code, signal, and output-limit failures settle visibly in the durable card.
- **Open records settle on resume** — an admitted review whose Host stops before writing `review/end` becomes `Interrupted` when that Session next starts; the terminated Codex process itself is not resumed.
- **New card surface** — the Plugins page ships a fourth card, and `maxTranscriptChars`/`maxOutputBytes`/`terminateGraceMs`/`timeoutMs`/`maxConcurrentReviews` are configurable through cordis.yml rather than the card, mirroring the other host-plane sections.
