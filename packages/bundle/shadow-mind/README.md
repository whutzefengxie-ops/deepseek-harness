# @deepseek-ai/dsh-shadow-mind

English | [中文](README.zh.md)

Installable profile patch for probabilistic Shadow Mind orchestration. Its manifest declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts `@deepseek-ai/dsh-shadow-mind-runtime` followed by `@deepseek-ai/dsh-tool-shadow-mind`.

## Installation

Install the published package into an existing profile:

```sh
dsh plugin --profile <profile> add @deepseek-ai/dsh-shadow-mind
```

A local tarball produced by `pnpm pack` is also accepted in place of the package name. The profile records the bundle dependency and appends it to `dsh.profile.bundles`; `dsh --profile <profile> --dump-config` shows the two inserted rows. The profile must already provide agents, settings, a `spawn` subagent provider, commands, tools, and approval, as the standard base profiles do.

Create definitions under `$DSH_HOME/shadow-minds/` or use the approved management tools. The [runtime README](../../shadow-mind/shadow-mind-runtime/README.md) owns scheduling, privacy, cancellation, and configuration semantics; the [tool README](../../shadow-mind/tool-shadow-mind/README.md) owns administration and approval behavior.

## Model Experience

### Mounted Shadow behavior

#### What the model sees

Installing the bundle makes the [eight management tools](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shadow-mind) visible and enables conditional independent Shadow child requests plus durable root report relays. Without any valid enabled definitions, the runtime sends no auxiliary model request and no relay.

#### Token effect

The eight fixed schemas add request tokens while mounted. Auxiliary child and relay tokens remain conditional on definitions, root tool turns, probability gates, model filters, pause state, and concurrency capacity.

#### KV Cache effect

Installing or removing the bundle changes the root tool-schema prefix. Shadow child requests use independent histories; accepted relays append to root history.

## Known Limitations and Deferred Work

- The bundle assumes the target profile already supplies every injected service and a provider named `spawn`; it does not assemble a standalone agent profile.
- The patch mounts model-facing management tools together with the runtime. Deployments that need automatic review without model editing authority should mount only the runtime row through their own profile patch.
- The bundle provides no dedicated Web client, keyboard shortcut, status panel, or `shadow-report` renderer.
