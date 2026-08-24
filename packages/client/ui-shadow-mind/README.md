# @deepseek-ai/dsh-client-ui-shadow-mind

English | [中文](README.zh.md)

Web administration for Shadow Mind under **Settings → Plugins → Shadow Mind**. The page reads the live `shadow-mind` settings namespace, manages Markdown-backed Shadow definitions through the generated `ctx.remote.shadowMind` API, and controls automatic scheduling for the currently selected root Session.

## Configuration

Installing `@deepseek-ai/dsh-shadow-mind` mounts this package automatically. The browser module appears only in Web profiles; its Host half is inert in headless compositions.

The sibling **Plugin list** tab reports the enabled and mounted state of the Shadow Mind runtime, management-tool, and browser entries. This package's own tab reports whether automatic scheduling and each Shadow definition are enabled.

The global form edits heartbeat probability, per-root concurrency, timeouts, report batching, model and reasoning defaults, argument disclosure, deterministic random seed, prompt/report limits, vendor preference, predicate thresholds, value-loop observation, stagnation windows and cooldowns, effort escalation, soft and hard budgets, frugal routing, repeat decay, and conflict synthesis. Saved values use the revision-fenced settings document and apply live. Clearing an optional field restores inheritance from the bundle configuration or the root Agent. The form enforces the runtime's cross-field window and budget relationships before saving.

The Shadow Agents section lists `$DSH_HOME/shadow-minds/*.md`, displays the exact definition directory and source file, reports isolated definition errors, and supports create, full edit, enable, disable, and delete. Each form exposes the definition id, display name, enabled/debug flags, activation probability, root-model filters, execution model, reasoning effort, timeout, extra tools, capture range, context inheritance, think-first planning, named prefilters and boosts, boost factor, holdout mode, and Markdown responsibility. Delete preserves the Shadow debug log. The page never displays or edits holdout literals; those remain in the owner-only runtime sidecar.

The current-session section reads root-only runtime status and provides pause, resume, and toggle actions. It shows active and pending work, admitted runs, prefilter skips, effective probabilities, budget spend and tier, cooldowns, pending escalations, value-loop counters, synthesis totals and failures, recent report metadata, and the latest terminal outcome with deliberation size, route, independence, verdict, capture sequence, and published child Session. Root Session activity refreshes this status automatically, and the page's Refresh action reads it explicitly. The client also turns a successful `/shadow` command result into an immediate composer notice, including while the Session remains blank and the durable command node is hidden behind the new-session Hero.

## Conversation presentation

An accepted `shadow-report` relay renders as a dedicated, always-visible Shadow Mind card instead of the generic collapsed context disclosure. Each batch groups its ordered reports and shows the Shadow name and id, report text, child Session button, and root `capturedThroughSeq`. The child button opens the published Session through the existing session navigator. The root Assistant response that consumed the relay receives a **Triggered by a Shadow Mind report** marker in its completed-turn tail.

The card and marker replay exclusively from durable Session events. An unreadable or foreign relay falls back to the generic context row, while quiet, irrelevant, failed, and discarded runs stay in the current-session status because they never produced a model-visible report.

## Security and failure behavior

The page is available only through the trusted local Web application and uses the same Remote and settings transports as other Web settings. Definition writes still pass through runtime validation and atomic owner-only file publication. Invalid ids, probabilities, routes, tools, timeouts, or empty responsibilities fail without replacing the existing file. The Web administration path is an explicit user action and does not request model-tool approval; model-initiated mutations continue to require `allowed-once` approval.

## Model Experience

None, as conversation presentation reads already-persisted report messages and does not assemble or send a provider request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Per-root pause state, counters, effective probabilities, budget state, cooldowns, recent reports, and synthesis diagnostics are process-local and shown only for the currently selected root Session; they are not durable user settings.
- The page lists local debug-log paths but does not render log contents.
- Holdout sidecar literals have no browser surface by design.
