# shadow-mind/

[English](README.md) | 中文

由全新一次性 subagent（子智能体）实现的概率式后台审查。该组把 root agent（根智能体）编排与面向模型的管理功能分离，因此部署可以启用自动审查，而不向 root 模型授予编辑全局 Shadow 定义的权限。

| 包 | 职责 | ctx key |
|---|---|---|
| [`shadow-mind-runtime/`](shadow-mind-runtime/README.zh.md) | 定义、调度、轨迹投影、child 所有权、报告批处理与 root 控制 | `ctx.shadowMind` |
| [`tool-shadow-mind/`](tool-shadow-mind/README.zh.md) | 8 个需要批准的管理工具和 `/shadow` 命令 | 注册工具和命令 |

可安装的 [`@deepseek-ai/dsh-shadow-mind`](../bundle/shadow-mind/README.zh.md) 组合包会把这两个包挂载到现有 profile。每次 Shadow 运行都使用 `spawn` subagent 提供方，以全新的 child Session 启动，并接收有界投影，而不是 root 模型的隐藏推理或完整工具输出。

定义位于 `$DSH_HOME/shadow-minds/*.md`；部署配置和实时用户设置仍由 settings 服务管理。[概率式 Shadow 编排决策](../../.agents/notes/implemented/feature/2026-08-22-probabilistic-shadow-mind-orchestration.zh.md)记录设计理由以及与 Pi Shadow Mind 的差异。
