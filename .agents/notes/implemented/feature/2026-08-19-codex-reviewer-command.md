# Agent Note: Human `/review` command over the local Codex CLI

Status: implemented

English | [中文](2026-08-19-codex-reviewer-command.zh.md)

## Problem

An operator watching a coding agent's session often wants an independent, second-opinion review of what the agent has produced so far — correctness, design, and risks — without spending a turn of the reviewed agent and without the reviewed model grading its own output. Sending "review the conversation" as prompt text would put the review on the same model that produced the work and consume one of its turns. Building admission into a UI surface would duplicate command discovery and command lifecycle logging. The result still needs a dedicated presentation because a long-running review must remain observable and recoverable after the browser request ends.

The review itself is a prompt-and-run job for an external tool. The local Codex CLI already accepts a non-interactive prompt (`codex exec`), carries its own model selection, reasoning-effort (`model_reasoning_effort`) and sandbox configuration, and can be driven entirely through stdin plus flags — no shell interpretation of conversation text is needed. A review run is unbounded in time and output. Keeping it inside the browser Remote leaves the composer submitting until Codex exits and lets refresh cancel the process through that request's signal. The reviewer therefore needs a durable lifecycle, Agent-owned cancellation, process-tree teardown, and output bounds.

## Decision

### `/review` is a host-plane command over the subprocess seam

`@deepseek-ai/dsh-command-reviewer` registers the global human command `/review` (审查者) through `ctx.commands` and requires `ctx.subprocess`. The handler projects the receiving session's derived messages into a plain-text transcript (`renderTranscript`: user/assistant text, tool calls, tool results; reasoning and image blocks are skipped), assembles the review prompt, and spawns one non-interactive run:

```text
codex exec --json --color never --ephemeral --skip-git-repo-check -s <sandbox> [-m <model>] -c model_reasoning_effort=<effort>
```

The prompt crosses the subprocess seam as batch stdin, so no conversation text ever enters argv or a shell boundary. Each run wraps the transcript in a delimiter containing a fresh UUID and tells Codex to treat its contents only as untrusted review evidence, not as instructions. On Windows the argv is wrapped in `cmd.exe /d /s /c` (the same boundary `dsh-subagent-codex` uses), so the configurable model is restricted to a portable identifier before the wrapper receives it; the Codex CLI itself must be installed and authenticated on the host. The run executes in the session's working directory (the process directory when the session carries none), with `read-only` as the default sandbox. Stdout is streamed JSONL; the decoder records public Codex phases and safe item summaries and extracts the final `agent_message` text.

The handler reads every section field per invocation, so settings edits apply live. It performs executable admission, preserving the subprocess provider's diagnostic when resolution fails, writes `review/start`, spawns the process with a private controller, and immediately returns a successful `sourceEventSeq` acknowledgement. The browser signal is used only for admission and does not reach the admitted process. The receiving Agent context owns the controller and settlement: normal completion terminates any residual descendants, while Agent or plugin teardown aborts the process tree; both paths wait for whole-tree exit before recording the terminal review event.

### Durable events own progress and refresh recovery

The log-only lifecycle is `review/start` → zero or more `review/activity` → `review/end`, correlated by the executor-minted `commandId`. Activities preserve Codex item identity and started/completed state while projecting only safe categories and summaries; reasoning content is not recorded. Completion, structured failure, malformed JSONL, output overflow, nonzero exit, signal termination, and owner cancellation all settle through `review/end` rather than a generic Remote abort.

`@deepseek-ai/dsh-client-ui-reviewer` folds this family into one Chat node and renders the final Markdown. Refresh replays the same running or terminal state; a page containing only mid-run activity or the terminal event reconstructs the card with an empty focus until the page containing `review/start` arrives. `command/done.sourceEventSeq` points at `review/start`; the generic command Definition hides its duplicate row when that richer source exists. No timer or synthetic percentage is used.

### The `command-reviewer` settings section owns every tunable

The plugin registers the `command-reviewer` settings namespace (base layer = composition entry) with the schema: `enabled` (the card's switch; the command refuses while off), `model` (empty or a portable identifier containing only letters, digits, `.`, `_`, `:`, `/`, `@`, `+`, and `-`), `thinkingEffort` (`low|medium|high`), `sandbox`, `prompt` (a `{transcript}` placeholder marks where the conversation goes; without one the transcript is appended), `context` (deployment-level scenario supplement), `maxTranscriptChars`, `maxOutputBytes`, and `terminateGraceMs` (bounded by the Node timer maximum). `maxOutputBytes` defaults to 8 MiB so repository inspection can carry command output while runaway processes remain bounded. `@deepseek-ai/dsh-client-ui-settings-plugins` renders the 审查者 (Reviewer) card in the Plugins settings page — the same card surface as Shell, Agent loop, and Web search — with a toggle, selects for effort and sandbox, and text areas for prompt and context. The card validates the model identifier before save, uses field-specific invalid-value copy, and warns that writable sandbox modes grant their permissions to transcript-driven review commands. A card renders nothing when the deployment does not compose the owning plugin.

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
- **Transcript-only review surface** — reasoning blocks, images, and attachments are not forwarded; the review sees text, tool calls, and tool results.
- **Codex presence is a host responsibility** — an executable-resolution failure blocks admission with the subprocess provider's diagnostic; authentication, JSONL, exit-code, signal, and output-limit failures settle visibly in the durable card.
- **New card surface** — the Plugins page ships a fourth card, and `maxTranscriptChars`/`maxOutputBytes`/`terminateGraceMs` are configurable through cordis.yml rather than the card, mirroring the other host-plane sections.
