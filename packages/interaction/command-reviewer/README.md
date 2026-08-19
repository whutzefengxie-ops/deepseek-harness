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
| `/review` without `codex` on `PATH` | `The Codex CLI is not available: codex was not found on PATH. Install @openai/codex and try again.` |
| `/review` whose Codex run fails | The durable review card settles as failed with the Codex error, exit code, signal, malformed-output diagnostic, or output-limit diagnostic. |

Every admitted invocation records `review/start`, zero or more `review/activity` records decoded from Codex JSONL, and one `review/end`, alongside the executor-owned log-only `command/run` / `command/done` pair. None joins model history. The browser request owns admission only: disconnecting or refreshing after `review/start` does not cancel the run. The receiving Agent's context owns the process; Agent or plugin teardown aborts its private signal, terminates the process tree, waits for whole-tree exit, and then records cancellation.

The Web client reconstructs these events as an independent review card. It shows the actual analysis phase and safe item summaries for commands, MCP tools, web searches, file changes, and message production; it never exposes hidden reasoning text or invents a percentage. Replay after refresh produces the same running or terminal card. A successful `command/done.sourceEventSeq` points at `review/start`, so the generic command row is suppressed once the richer domain record exists.

## Settings section

The plugin registers the `command-reviewer` settings namespace when a settings service is mounted; the Web Plugins page renders it as the 审查者 (Reviewer) card. Every field layers schema defaults, the composition entry, and the user document:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether `/review` runs at all — the card's enable switch. |
| `model` | `''` | `codex exec --model`; empty uses the Codex default model, while a non-empty value must be a portable identifier containing only letters, digits, `.`, `_`, `:`, `/`, `@`, `+`, or `-`. |
| `thinkingEffort` | `medium` | `codex exec -c model_reasoning_effort=…`; one of `low`, `medium`, `high`. |
| `sandbox` | `read-only` | `codex exec --sandbox`; one of `read-only`, `workspace-write`, `danger-full-access`. |
| `prompt` | built-in review instructions | Review instructions; `{transcript}` marks where the conversation goes, otherwise the transcript is appended. |
| `context` | `''` | Deployment-level scenario context appended as a labelled section. |
| `maxTranscriptChars` | `200000` | Tail-keep bound in characters for the rendered transcript. |
| `maxOutputBytes` | `65536` | Complete byte cap for the streamed Codex JSONL output. |
| `terminateGraceMs` | `3000` | Escalation grace in milliseconds for process-tree termination; bounded by the Node timer maximum. |

The prompt never rides argv — it crosses the subprocess seam as batch stdin, so no conversation text enters a shell boundary. The model identifier is validated before it can reach the Windows `cmd.exe` wrapper. Stdout is a streamed JSONL pipe, while stderr remains a bounded diagnostic tail. The Codex run is non-interactive, ephemeral, color-stripped, and allowed outside Git repositories; it runs in the session's working directory (the process directory when the session carries none).

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
- **Transcript-only review surface** — reasoning blocks, images, and attachments are not forwarded to Codex; the review sees conversation text, tool calls, and tool results.
- **Codex presence is the host's job** — a missing or unauthenticated Codex install surfaces as the command's direct errors; the plugin performs no setup.
