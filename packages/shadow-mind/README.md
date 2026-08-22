# shadow-mind/

English | [中文](README.zh.md)

Probabilistic background review built from fresh one-shot subagents. The group separates root-agent orchestration from model-facing administration so a deployment can enable automatic review without granting the root model authority to edit global Shadow definitions.

| Package | Role | ctx key |
|---|---|---|
| [`shadow-mind-runtime/`](shadow-mind-runtime/README.md) | Definitions, scheduling, trajectory projection, child ownership, report batching, and root controls | `ctx.shadowMind` |
| [`tool-shadow-mind/`](tool-shadow-mind/README.md) | Eight approved management tools and the `/shadow` command | registers tools and commands |

The installable [`@deepseek-ai/dsh-shadow-mind`](../bundle/shadow-mind/README.md) bundle mounts both packages into an existing profile. Every Shadow run uses the `spawn` subagent provider, starts with a fresh child Session, and receives a bounded projection rather than the root model's hidden reasoning or complete tool output.

Definitions live in `$DSH_HOME/shadow-minds/*.md`; deployment and live-user settings remain in the settings service. The [probabilistic Shadow orchestration decision](../../.agents/notes/implemented/feature/2026-08-22-probabilistic-shadow-mind-orchestration.md) owns the design rationale and the differences from Pi Shadow Mind.
