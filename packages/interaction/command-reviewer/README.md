# @deepseek-ai/dsh-command-reviewer

English | [中文](README.zh.md)

Human-facing `/review` control over the local Codex CLI. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. Each run projects the receiving session's derived conversation into a review prompt, starts one non-interactive `codex exec --json` through [`ctx.subprocess`](../../subprocess/subprocess/README.md), immediately acknowledges the durable start, and records real Codex progress plus the final review in the Session log.

## Command contract

Every recorded activity belongs to a real Codex item and stores its external id as `item:<id>`. Repeated events for that id must retain one activity category. Top-level turn lifecycle records are ignored because they do not identify a separate public operation. One run records at most `maxActivityEvents` activity transitions; the first excess transition terminates Codex and settles the card with the limit diagnostic.

| Input | Result |
|---|---|
| `/review` | Starts one Codex review of the conversation so far and immediately clears the submitting composer. |
| `/review <focus>` | Same, with the focus appended to the prompt as a labelled section and shown on the review card. |
| `/review` with no conversation yet | `No conversation output to review yet.` — no process is spawned. |
| `/review` while the plugin is disabled | `The reviewer is disabled. Turn it on under Settings → Plugins.` — no process is spawned. |
| `/review` while this Agent is already at `maxConcurrentReviews` | Reports the active count and configured limit; no second process is spawned. |
| `/review` whose assembled prompt exceeds `maxPromptBytes` | Reports the exact UTF-8 byte count and configured limit; no process is spawned and no `review/start` is recorded. |
| `/review` when the subprocess provider cannot resolve `codex` | The command reports the provider's exact resolution diagnostic and does not spawn a process. |
| `/review` with the local provider on POSIX in an explicit composition | The composer clears after admission, then the durable card fails with `The review could not start: subprocess-local: host-death termination requires Windows Job Object ownership`; Codex is not started. The shipped Web composition omits this unsupported command. |
| `/review` whose Codex run fails | The durable review card settles as failed with every observed Codex error, timeout, exit code or signal, malformed-output diagnostic, byte-limit diagnostic, and activity-event-limit diagnostic. Final review text decoded before a later failure remains above those diagnostics. |

Every admitted invocation records `review/start`, zero or more `review/activity` records decoded from Codex JSONL, and one `review/end`, alongside the executor-owned log-only `command/run` / `command/done` pair. Each terminal record contains a result or diagnostic with at least one non-whitespace character. The command disables generic input recording, so `command/run` omits `args`; `review/start.focus` is the single durable copy of an admitted focus. `review/start.request` preserves the exact prompt, canonical argv, explicit child-environment entries, working directory, required `hostDeath: "terminate"` behavior, and elapsed timeout used for the Codex request. The transcript omits instruction, catalog, and runtime-snapshot context instead of misattributing that configuration as user dialogue; direct messages, model output, tool activity, notices, relays, recalls, and compaction summaries remain review evidence. None joins the reviewed Agent's model history. The handler commits request admission immediately before `review/start`, asks the Session store to flush, and then reads from `ctx.sessionPersistence` at the new sequence number with the review owner's cancellation signal; Codex starts only when the stored event exactly matches that `review/start` and every flush listener succeeds. A missing, failed, incomplete, or owner-cancelled start checkpoint prevents the spawn and publishes a failed or owner-cancelled terminal record when storage remains available. Disconnecting or refreshing after admission does not cancel the run. The receiving Agent's context owns the process; timeout, Agent teardown, and plugin teardown terminate the process tree and wait for whole-tree exit before recording the terminal result. Owner teardown arms the independent `teardownTimeoutMs` deadline across stdout closure, subprocess completion, process-tree exit confirmation, and lifecycle persistence, so a non-settling subprocess observer, flush listener, or backend read becomes an explicit teardown failure. If subprocess spawn synchronously initiates owner teardown and then throws, the review settles as owner cancellation rather than a launch failure. A terminal record must also be read back as the exact `review/end` before the concurrency slot is released. After exact readback, a separate `session/flush` listener failure is logged but does not keep the completed review owned. Failed or timed-out subprocess settlement, exit confirmation, terminal append, or exact terminal readback leaves the run owned and makes teardown report the failure. A subprocess provider that cannot terminate the tree when its Host exits rejects before Codex starts. The shipped local provider admits this requirement only through the Windows kill-on-close Job Object; its POSIX guardian cannot contain `setsid()` descendants and rejects before Codex starts. When a later Host resumes a Session, recovery first settles every `/review` `command/run` that has neither `review/start` nor `command/done` as a generic command error. An inherited fork prefix uses `Review was not continued in this fork; the source session review is unaffected.`; every other prefix uses `Review interrupted because its previous host stopped before recording admission.`, closing Host loss during executable resolution or start publication without inventing an admitted review. Recovery then appends a missing successful `command/done` anchored to every acknowledged `review/start`, including a review whose terminal record already exists. It appends one `interrupted` end only for an open non-fork review; the persisted guarantee means its old process tree has lost execution ability. A fork that inherits an open review instead records that the run was not continued in the child and leaves the source Session unchanged. Compaction does not move or settle a review because it remains in the same Session and owner.

The Web client reconstructs these events as an independent review card. It indexes activities by external item id while replaying and snapshots them in first-seen order for publication. It localizes the categories and shows safe item summaries for real Codex reasoning, commands, MCP tools, web searches, file changes, and message production; it never exposes hidden reasoning text or invents a percentage. Replay after refresh produces the same running or terminal card; a recovered or fork-inherited open review appears as `Interrupted` with its recorded cause. A successful `command/done.sourceEventSeq` points at `review/start`, and the review node also claims the branded command identity, so the generic command row stays suppressed when a paged window has not loaded that start event yet.

## Settings section

The plugin registers the `command-reviewer` settings namespace when a settings service is mounted; the Web Plugins page renders it as the 审查者 (Reviewer) card. Every field layers schema defaults, the composition entry, and the user document:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether `/review` runs at all — the card's enable switch. |
| `model` | `''` | `codex exec --model`; empty uses the Codex default model, while a non-empty value must be a portable identifier containing only letters, digits, `.`, `_`, `:`, `/`, `@`, `+`, or `-`. |
| `thinkingEffort` | `medium` | `codex exec -c model_reasoning_effort=…`; one of `low`, `medium`, `high`. |
| `sandbox` | `read-only` | `codex exec --sandbox`; one of `read-only`, `workspace-write`, `danger-full-access`. Writable modes allow transcript-driven review commands to use the selected permissions. |
| `prompt` | built-in review instructions | Review instructions; `{transcript}` marks where the conversation goes, otherwise the transcript is appended. |
| `context` | `''` | Deployment-level scenario context appended as a labelled section. |
| `maxTranscriptChars` | `200000` | Tail-keep bound in Unicode code points; rendering counts the input incrementally and retains only this bounded tail. |
| `maxPromptBytes` | `1048576` | UTF-8 byte cap for the complete prompt after instructions, transcript protection, context, and focus are assembled. |
| `maxOutputBytes` | `8388608` | Complete byte cap for the streamed Codex JSONL output; large enough for repository inspection while still terminating runaway output. |
| `maxActivityEvents` | `1000` | Maximum durable `review/activity` transitions from one run; the first excess transition terminates Codex before it is appended. |
| `subprocessGraceMs` | `3000` | Provider-specific termination and collected-pipe drain grace in milliseconds; the shipped Windows provider force-terminates its Job Object immediately and uses this value to bound post-exit collected-pipe draining. |
| `timeoutMs` | `3600000` | Maximum elapsed time for one review before its process tree is terminated; bounded by the Node timer maximum. |
| `teardownTimeoutMs` | `10000` | Maximum milliseconds from Agent or plugin teardown through stdout closure, subprocess completion, process-tree exit confirmation, and lifecycle persistence; bounded by the Node timer maximum. |
| `maxConcurrentReviews` | `1` | Maximum concurrently active reviews owned by one Agent. |

The prompt never rides argv — it crosses the subprocess seam as batch stdin, so no conversation text enters a shell boundary. Each run wraps the transcript in an unpredictable delimiter and explicitly identifies it as untrusted evidence that must not supply instructions; this reduces prompt-injection risk but does not make writable sandbox modes safe for untrusted conversations. The complete UTF-8 prompt is checked against `maxPromptBytes` before persistence or process admission. Codex is started through the canonical path returned by the active subprocess provider. When that path is a Windows batch wrapper, the provider also resolves `cmd.exe`; argv uses `/d /q /v:off /s /c` and expands `DSH_CODEX_REVIEWER_EXECUTABLE`, while the explicit child environment carries the quoted canonical wrapper path. This form preserves paths containing spaces and command metacharacters without placing conversation text in the shell command. The model identifier is validated before it can reach that interpreter. Stdout is a streamed JSONL pipe bounded by both `maxOutputBytes` and `maxActivityEvents`, while stderr remains a bounded diagnostic tail. The Codex run is non-interactive, ephemeral, color-stripped, and allowed outside Git repositories; it runs in the session's working directory (the process directory when the session carries none).

## Composition

The producer injects `commands`, `sessions`, `sessionPersistence`, and `subprocess`, and consumes `settings` when one is mounted:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: './.sessions'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: command-reviewer
  name: '@deepseek-ai/dsh-command-reviewer'
```

The shipped Web composition mounts it on the Windows host plane beside the command registry, and `@deepseek-ai/dsh-client-ui-settings-plugins` contributes the settings card. POSIX omits that row because the shipped provider cannot satisfy its Host-death requirement; deployments with an equivalent provider may compose the package explicitly. The Codex CLI itself must be installed on the host (`codex` on `PATH`) and authenticated through its persistent login in the subprocess provider's execution world; this plugin neither installs nor authenticates it. Ambient variables whose names contain `KEY`, `TOKEN`, `SECRET`, or `PASSWORD` are removed by the local subprocess provider, and this plugin does not authorize API credentials into the child environment.

## Model Experience

### Human `/review` command

#### What the model sees

Nothing. The slash input, the built review prompt, the Codex run, and the review text never enter a model request of the reviewed agent; the Codex process is an auxiliary non-interactive run outside the harness's LLM seam.

#### Token effect

The command lifecycle adds no model tokens. `maxTranscriptChars` limits the transcript tail, and `maxPromptBytes` limits the complete review prompt.

#### KV Cache effect

None: no model request of the reviewed agent is involved, so no cached prefix is touched.

## Known Limitations and Deferred Work

- **One run per invocation** — `/review` runs a single non-interactive `codex exec`; the review cannot be continued, resumed, or asked follow-up questions from inside the command.
- **Transcript-only review surface** — instruction, catalog, and runtime-snapshot context, reasoning blocks, images, and attachments are not forwarded to Codex; the review sees conversation text, tool calls, and tool results.
- **Codex presence and persistent login are deployment prerequisites** — a missing executable fails command admission directly; an authentication failure after spawn ends the durable Reviewer card as Failed. Authentication that exists only in an ambient API-key environment variable is unavailable to the shipped local subprocess provider because its secret-variable scrub removes that value.
- **The shipped local Host-death guarantee is Windows-only** — the default Web profile omits `/review` on POSIX; an explicit POSIX composition needs a subprocess provider backed by cgroups, a supervisor, or another ownership mechanism that can contain daemonized descendants.
