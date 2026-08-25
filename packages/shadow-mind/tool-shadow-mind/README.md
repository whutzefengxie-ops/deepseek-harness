# @deepseek-ai/dsh-tool-shadow-mind

English | [中文](README.zh.md)

Model-facing administration for `ctx.shadowMind` plus the human `/shadow` command. The package is separate from the runtime so deployments can run automatic Shadows without allowing the root model to edit global definitions or scheduling settings.

## Tools and approval

The generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shadow-mind) owns the complete schemas for `list_shadows`, `create_shadow`, `update_shadow`, `enable_shadow`, `disable_shadow`, `delete_shadow`, `get_shadow_config`, and `update_shadow_config`.

`list_shadows` and `get_shadow_config` are read-only. Every create, update, enable, disable, delete, or settings write calls `ctx.approval.request()` with the exact calling agent, tool name, call id, signal, and a human-readable reason. Only `allowed-once` commits the mutation; denied, unavailable, cancelled, or broader outcomes fail without changing disk or settings. A non-agent caller cannot mutate configuration.

Definition outputs are stable pretty JSON and omit source paths. A create defaults `enabled` to true, `debug` to false, `activation_probability` to `0.3`, `capture` to `full`, `context` to `standard`, `think_first` and `holdout` to false, `boost_factor` to `1`, and array fields to empty. The create and update schemas also expose named prefilters and boosts. Holdout literals are deliberately absent: they live only in the owner-side sidecar and no tool reads or writes them. `update_shadow` requires at least one supplied field. Delete removes the definition but preserves its runtime debug log. `update_shadow_config` requires at least one supplied setting and exposes every live scheduling, detector, value-loop, budget, decay, and synthesis field through runtime schema validation. `null` removes an optional user override, and one call applies all supplied settings atomically so related budget fields can be reset together.

All eight tools use generic cards. Read operations declare read presentation; mutations declare execute presentation. Registrations are Cordis effects and disappear when the plugin unloads.

## Command

`/shadow status|pause|resume|toggle` controls only the current root agent. Empty input is `status`; invalid input returns usage. Every successful command reports active and pending work, admitted runs, prefilter skips, effective probabilities, budget spend and tier, cooldowns, pending escalations, value-loop counters, synthesis totals, recent report metadata, and the latest terminal outcome when present. Pause advances the root cancellation epoch and aborts admitted Shadow and synthesis work, while definitions and live global settings remain unchanged. Commands reject descendant agents through the runtime service.

## Failures

The plugin requires the tool, Shadow runtime, command, and approval services. Missing services fail composition. Approval refusal, invalid management fields, unknown definitions, and settings persistence failures surface as tool errors; no mutation is reported before its owning write succeeds.

## Model Experience

### Management tool schemas

#### What the model sees

The model sees the generated [eight Shadow management schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shadow-mind) while this plugin is visible. Six definition operations and two settings operations are distinct tools; the human `/shadow` command is not a model tool.

#### Token effect

Eight fixed schemas are sent with each request while visible. Definition content and current settings do not enter the schemas.

#### KV Cache effect

The schema prefix is stable while tool visibility and definitions are unchanged.

### Management tool results

#### What the model sees

Successful reads and approved writes return one pretty-printed JSON text block. Definition results include authoring fields and prompts but omit absolute source paths; catalog diagnostics can include a failing definition path and validation message.

#### Token effect

Results are data-dependent and remain in ordinary logged tool history until compaction. Definition prompts and diagnostics have no package-owned output truncation.

#### KV Cache effect

Tool results append after the reusable request prefix and do not rewrite earlier tokens.

## Known Limitations and Deferred Work

- The model cannot import an existing Pi Shadow file or batch several definition mutations in one approved transaction.
- Read tools can expose complete definition prompts and local diagnostic paths to the calling model.
- The command has no keyboard shortcut or dedicated status panel; clients render it through the generic command path.
