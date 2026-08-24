# @deepseek-ai/dsh-tool-shadow-mind

[English](README.md) | 中文

位于 `ctx.shadowMind` 之上的面向模型管理功能，以及面向人类的 `/shadow` 命令。本包与运行时分离，因此部署可以运行自动 Shadow，而不允许 root 模型编辑全局定义或调度设置。

## 工具与批准

生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shadow-mind)负责记录 `list_shadows`、`create_shadow`、`update_shadow`、`enable_shadow`、`disable_shadow`、`delete_shadow`、`get_shadow_config` 和 `update_shadow_config` 的完整 schema。

`list_shadows` 与 `get_shadow_config` 只读。每次创建、更新、启用、禁用、删除或 settings 写入都会使用精确的调用 agent、工具名称、call id、signal 和人类可读原因调用 `ctx.approval.request()`。只有 `allowed-once` 会提交变更；拒绝、不可用、取消或更宽泛的结果都会失败，且不会更改磁盘或 settings。非 agent 调用方无法变更配置。

定义输出是稳定的格式化 JSON，并省略源路径。创建操作默认令 `enabled` 为 true、`debug` 为 false、`activation_probability` 为 `0.3`、`capture` 为 `full`、`context` 为 `standard`、`think_first` 与 `holdout` 为 false、`boost_factor` 为 `1`，数组字段为空。创建与更新 schema 还公开具名 prefilter 与 boost。Holdout literal 被刻意排除：它们只存在于 owner 侧 sidecar，没有任何工具读取或写入它们。`update_shadow` 要求至少提供一个字段。删除会移除定义，但保留其运行时调试日志。`update_shadow_config` 要求至少提供一项设置，并通过运行时 schema 验证公开全部实时调度、检测器、value-loop、预算、衰减与综合字段。

8 个工具都使用通用卡片。读取操作声明 read 展示；变更操作声明 execute 展示。注册项是 Cordis effect，并在插件卸载时消失。

## 命令

`/shadow status|pause|resume|toggle` 只控制当前 root agent。空输入等同于 `status`；无效输入返回用法。每条成功命令都会报告活动与等待工作、已准入运行、prefilter skip、有效概率、预算消耗与层级、冷却、待处理提升、value-loop 计数、综合总数、近期报告元数据，以及存在时的最近终态结果。暂停会推进 root 取消 epoch 并中止已准入 Shadow 与综合工作，但定义与实时全局 settings 保持不变。后代 agent 会被运行时服务拒绝。

## 失败

插件要求 tool、Shadow runtime、command 和 approval 服务。缺少服务会使组合失败。批准拒绝、无效管理字段、未知定义和 settings 持久化失败会表现为工具错误；归属写入成功前不会报告任何变更。

## 模型体验

### 管理工具 schema

#### 模型看到的内容

本插件可见时，模型会看到生成的 [8 个 Shadow 管理 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shadow-mind)。6 个定义操作与 2 个 settings 操作是不同工具；面向人类的 `/shadow` 命令不是模型工具。

#### Token 影响

可见期间，每次请求都会发送 8 个固定 schema。定义内容和当前 settings 不进入 schema。

#### KV Cache 影响

工具可见性和定义不变时，schema 前缀保持稳定。

### 管理工具结果

#### 模型看到的内容

成功读取和经批准的写入返回一个格式化 JSON 文本块。定义结果包含创作字段与 prompt，但省略绝对源路径；目录诊断可以包含失败定义路径和验证消息。

#### Token 影响

结果取决于数据，并保留在普通已记录工具历史中，直到 compaction。定义 prompt 与诊断没有本包自有输出截断。

#### KV Cache 影响

工具结果追加在可复用请求前缀之后，不会重写更早的 token。

## 已知限制与暂缓事项

- 模型无法导入现有 Pi Shadow 文件，也无法在一个已批准事务中批量执行多项定义变更。
- 读取工具可以向调用模型公开完整定义 prompt 与本地诊断路径。
- 命令没有键盘快捷键或专用状态面板；客户端通过通用命令路径渲染它。
