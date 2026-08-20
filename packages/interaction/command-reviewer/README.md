# @deepseek-ai/dsh-command-reviewer

English | [中文](README.zh.md)

Human-facing `/review` control over the local Codex CLI. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. Each run projects the receiving session's derived conversation into a review prompt, starts one non-interactive `codex exec --json` through [`ctx.subprocess`](../../subprocess/subprocess/README.md), immediately acknowledges the durable start, and records real Codex progress plus the final review in the Session log.

## Command contract

| Input | Result |
|---|---|
| `/review` | Starts one Codex review of the conversation so far and immediately clears the submitting composer. |
| `/review <focus>` | Same, with the focus appended to the prompt as a labelled section and shown on the review card. |
| `/review` with no conversation yet | `No conversation output to review yet.` — no process is spawned. |
| `/review` while the plugin is disabled | `The reviewer is disabled. Turn it on under Settings → Plugins.` — no process is spawned. |
| `/review` while this Agent is already at `maxConcurrentReviews` | Reports the active count and configured limit; no second process is spawned. |
| `/review` when the subprocess provider cannot resolve `codex` | The command reports the provider's exact resolution diagnostic and does not spawn a process. |
| `/review` whose Codex run fails | The durable review card settles as failed with every observed Codex error, timeout, exit code or signal, malformed-output diagnostic, and output-limit diagnostic. |

Every admitted invocation records `review/start`, zero or more `review/activity` records decoded from Codex JSONL, and one `review/end`, alongside the executor-owned log-only `command/run` / `command/done` pair. `review/start.request` preserves the exact prompt, canonical argv, explicit child-environment entries, working directory, and elapsed timeout used for the Codex request. The transcript omits instruction, catalog, and runtime-snapshot context instead of misattributing that configuration as user dialogue; direct messages, model output, tool activity, notices, relays, recalls, and compaction summaries remain review evidence. None joins the reviewed Agent's model history. The handler commits request admission immediately before `review/start`, so a browser disconnect cannot leave a running review paired with an error `command/done`; disconnecting or refreshing after that record does not cancel the run. The receiving Agent's context owns the process; timeout, Agent teardown, and plugin teardown terminate the process tree and wait for whole-tree exit before recording the terminal result. If whole-tree exit cannot be confirmed, the run publishes no misleading terminal record, retains its concurrency slot, and reports the cleanup failure during teardown. When a later Host resumes a Session containing an open `review/start`, it appends a missing successful `command/done` anchored to that start before appending one `interrupted` end record, closing both durable lifecycles because the previous process can no longer be running.

The Web client reconstructs these events as an independent review card. It shows the actual analysis phase and safe item summaries for commands, MCP tools, web searches, file changes, and message production; it never exposes hidden reasoning text or invents a percentage. Replay after refresh produces the same running or terminal card; a recovered open review appears as `Interrupted`. A successful `command/done.sourceEventSeq` points at `review/start`, so the generic command row is suppressed once the richer domain record exists.

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
| `maxTranscriptChars` | `200000` | Tail-keep bound in characters for the rendered transcript. |
| `maxOutputBytes` | `8388608` | Complete byte cap for the streamed Codex JSONL output; large enough for repository inspection while still terminating runaway output. |
| `terminateGraceMs` | `3000` | Escalation grace in milliseconds for process-tree termination; bounded by the Node timer maximum. |
| `timeoutMs` | `1800000` | Maximum elapsed time for one review before its process tree is terminated; bounded by the Node timer maximum. |
| `maxConcurrentReviews` | `1` | Maximum concurrently active reviews owned by one Agent. |

The prompt never rides argv — it crosses the subprocess seam as batch stdin, so no conversation text enters a shell boundary. Each run wraps the transcript in an unpredictable delimiter and explicitly identifies it as untrusted evidence that must not supply instructions; this reduces prompt-injection risk but does not make writable sandbox modes safe for untrusted conversations. Codex is started through the canonical path returned by the active subprocess provider. When that path is a Windows batch wrapper, the provider also resolves `cmd.exe`; argv uses `/d /q /v:off /s /c` and expands `DSH_CODEX_REVIEWER_EXECUTABLE`, while the explicit child environment carries the quoted canonical wrapper path. This form preserves paths containing spaces and command metacharacters without placing conversation text in the shell command. The model identifier is validated before it can reach that interpreter. Stdout is a streamed JSONL pipe, while stderr remains a bounded diagnostic tail. The Codex run is non-interactive, ephemeral, color-stripped, and allowed outside Git repositories; it runs in the session's working directory (the process directory when the session carries none).

## Composition

The producer injects `commands` and `subprocess`, and consumes `settings` when one is mounted:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: command-reviewer
  name: '@deepseek-ai/dsh-command-reviewer'
```

The shipped Web composition mounts it on the host plane beside the command registry, and `@deepseek-ai/dsh-client-ui-settings-plugins` contributes the settings card. The Codex CLI itself must be installed and authenticated on the host (`codex` on `PATH`); this plugin neither installs nor authenticates it.

## Model Experience

### Human `/review` command

#### What the model sees

Nothing. The slash input, the built review prompt, the Codex run, and the review text never enter a model request of the reviewed agent; the Codex process is an auxiliary non-interactive run outside the harness's LLM seam.

#### Token effect

The command lifecycle adds no model tokens. The review prompt is sized by the conversation transcript, bounded by `maxTranscriptChars`.

#### KV Cache effect

None: no model request of the reviewed agent is involved, so no cached prefix is touched.

## Known Limitations and Deferred Work

- **One run per invocation** — `/review` runs a single non-interactive `codex exec`; the review cannot be continued, resumed, or asked follow-up questions from inside the command.
- **Transcript-only review surface** — instruction, catalog, and runtime-snapshot context, reasoning blocks, images, and attachments are not forwarded to Codex; the review sees conversation text, tool calls, and tool results.
- **Codex presence is the host's job** — a missing or unauthenticated Codex install surfaces as the command's direct errors; the plugin performs no setup.
