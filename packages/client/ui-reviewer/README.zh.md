# @deepseek-ai/dsh-client-ui-reviewer

[English](README.md) | 中文

持久化 `/review` 生命周期的浏览器呈现。该包把会话中的 `review/start`、`review/activity` 与 `review/end` 事件折叠为一个带键 Chat 节点，因此实时投递、分页历史与刷新重放会渲染出相同的审查状态。分页尚未加载 `review/start` 时，仍会以空关注点重建可见活动和终态结果；较早分页到达后再补入关注点。

## 呈现

`review/start` 到达后卡片立即出现。卡片展示可选关注点、当前状态，以及分析、命令、工具、搜索、文件修改与结果生成对应的真实 Codex JSONL 活动。活动详情只包含安全的操作摘要，不显示隐藏推理文本，也不虚构百分比。`review/end` 会加入最终 Markdown 审查，或失败、取消、宿主中断诊断。

宿主命令返回启动记录的 `sourceEventSeq`。这份权威审查节点存在时，通用斜杠命令 Definition 会隐藏重复的成功行。

## 组合方式

该包把 Conversation Definition、locale 字典与带键的 `reviewer` Chat 渲染器注册为 Cordis effect。随附的 Web bundle 在 `ui-conversation` 之后挂载它。

## 模型体验

无，因为该包只渲染纯日志会话事实，不会加入提示词、工具、请求或模型可见结果。

#### KV Cache 影响

无。

## 已知限制与后续工作

- 卡片只报告 Codex 公开 JSONL 生命周期；CLI 不提供完成百分比。
- 刷新可以重建持久化事件，但无法重新连接原始 stdout；后续宿主事件仍会继续更新同一节点，恢复会话的宿主会把未闭合记录结束为「已中断」。
