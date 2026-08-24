# @deepseek-ai/dsh-client-ui-shadow-mind

[English](README.md) | 中文

Shadow Mind 的 Web 管理界面，位于**设置 → 插件 → Shadow Mind**。该页面读取实时 `shadow-mind` settings 命名空间，通过生成的 `ctx.remote.shadowMind` API 管理 Markdown Shadow 定义，并控制当前所选 root Session 的自动调度。

## 配置

安装 `@deepseek-ai/dsh-shadow-mind` 会自动挂载本包。浏览器模块只出现在 Web profile；Host 半侧在 headless 组合中不执行任何行为。

同级的**插件列表**标签会报告 Shadow Mind 运行时、管理工具和浏览器配置项是否启用及已挂载。本包自己的标签会显示自动调度和每个 Shadow 定义是否启用。

全局表单编辑心跳概率、每 root 并发数、超时、报告批处理、模型与推理强度默认值、参数披露、确定性随机种子、prompt／报告限制、vendor 偏好、谓词阈值、value-loop 观察、停滞窗口与冷却、effort 提升、软硬预算、节省路由、重复衰减和冲突综合。保存使用 revision 设栅的 settings 文档，并实时生效。清除可选字段会恢复继承 bundle 配置或 root Agent。表单会在保存前强制执行运行时的跨字段窗口与预算关系。

Shadow Agents 区域列出 `$DSH_HOME/shadow-minds/*.md`，显示准确的定义目录和源文件，报告隔离的定义错误，并支持创建、完整编辑、启用、停用和删除。每个表单包含定义 id、显示名称、enabled/debug 标志、激活概率、root 模型过滤器、运行模型、推理强度、超时、额外工具、截获范围、上下文继承、think-first 规划、具名 prefilter 与 boost、boost factor、holdout 模式和 Markdown 职责。删除会保留 Shadow 调试日志。页面绝不显示或编辑 holdout literal；它们只保留在 owner-only 运行时 sidecar。

当前会话区域读取仅 root 可用的运行状态，并提供暂停、恢复和切换操作。它会显示活动与等待工作、已准入运行、prefilter skip、有效概率、预算消耗与层级、冷却、待处理提升、value-loop 计数、综合总数与失败、近期报告元数据，以及带 deliberation 大小、路由、独立性、verdict、截取序号和已发布 child Session 的最近终态结果。root Session 活动会自动刷新该状态，页面的“刷新”操作也会显式读取它。客户端还会把成功的 `/shadow` 命令结果转成即时 composer 提示；即使 Session 仍为空、持久命令节点被新会话 Hero 隐藏，也能看到结果。

## 会话展示

已接受的 `shadow-report` relay 会显示为始终可见的 Shadow Mind 专属卡片，而不是通用的折叠上下文行。一个批次按顺序分组展示其中的报告，每份报告包含 Shadow 名称与 id、报告正文、child Session 按钮以及 root `capturedThroughSeq`。child 按钮通过现有会话导航打开已发布的 Session。消费该 relay 的 root Assistant 回复会在已完成轮次的尾部显示**由 Shadow Mind 报告触发**标记。

卡片和标记只从持久化 Session 事件重放。不可读或来自其他版本的 relay 会回退到通用上下文行；无需补充、与职责不相关、失败和已丢弃的运行不会产生面向模型的报告，因此继续显示在当前会话状态中。

## 安全与失败行为

该页面只能通过受信任的本地 Web 应用访问，并使用与其他 Web 设置相同的 Remote 和 settings 传输。定义写入仍经过运行时验证和 owner-only 原子文件发布。无效 id、概率、路由、工具、超时或空职责会失败，且不会替换现有文件。Web 管理路径是用户显式操作，不请求模型工具 approval；模型发起的修改仍要求 `allowed-once` approval。

## 模型体验

无，因为会话展示读取已经持久化的报告消息，不组装或发送提供方请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 每个 root 的暂停状态、计数、有效概率、预算状态、冷却、近期报告和综合诊断属于进程本地状态，只显示当前所选 root Session，不是持久用户设置。
- 页面列出本地调试日志路径，但不渲染日志内容。
- Holdout sidecar literal 被刻意排除在浏览器界面之外。
