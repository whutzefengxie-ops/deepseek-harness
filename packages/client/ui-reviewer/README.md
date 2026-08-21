# @deepseek-ai/dsh-client-ui-reviewer

English | [中文](README.zh.md)

Browser presentation for the durable `/review` lifecycle. The package folds `review/start`, `review/activity`, and `review/end` Session events into one keyed Chat node, so live delivery, paged history, and refresh replay render the same review state. A page that has not loaded `review/start` yet still reconstructs the visible activities and terminal result with an empty focus, then adopts the focus when the earlier page arrives.

## Presentation

The card appears as soon as `review/start` arrives. It shows the optional focus, current status, and real Codex JSONL item activity for analysis, commands, tools, searches, file changes, and result production. Categories without a safe item detail are localized in the current interface language. A running card with no activity says that it is waiting for Codex events; a terminal card never retains that waiting message. An activity without its own completion event is shown as stopped once the review reaches any terminal state. Activity details contain safe operation summaries, never hidden reasoning text or invented percentages. `review/end` adds the final Markdown review or a failure, cancellation, or interrupted-host diagnostic.

The host command returns `sourceEventSeq` for the start record, and the review node exposes the same branded command identity as its presentation claim. The generic slash-command Definition suppresses its duplicate success row by start anchor or command identity, including while paged history has not loaded `review/start` yet.

## Composition

The package registers its Conversation Definition, locale dictionary, and `reviewer` keyed Chat renderer as Cordis effects. The shipped Web bundle mounts it after `ui-conversation`.

## Model Experience

None, as this package renders log-only Session facts and adds no prompt, tool, request, or model-visible result.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The card reports Codex's public JSONL lifecycle only; the CLI does not provide a completion percentage.
- Refresh reconstructs durable events but cannot reconnect to raw stdout; later Host events continue updating the same node, and a resumed Host closes an open record as `Interrupted`.
