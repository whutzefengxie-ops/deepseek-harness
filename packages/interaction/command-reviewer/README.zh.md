# @deepseek-ai/dsh-command-reviewer

[English](README.md) | 中文

面向本地 Codex CLI 的人工 `/review` 命令（审查者）。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此所有已组合的命令适配器都能发现并执行它，而不占用模型回合。每次运行都会把接收会话推导出的对话投影为一份审查提示词，通过 [`ctx.subprocess`](../../subprocess/subprocess/README.md) 启动一次非交互的 `codex exec --json`，立即确认持久化的启动记录，并把真实 Codex 进度与最终审查结果写入会话日志。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/review` | 启动一次针对当前对话的 Codex 审查，并立即清空提交输入框。 |
| `/review <关注点>` | 同上，关注点会作为带标签的段落追加到提示词中，并显示在审查卡片上。 |
| 尚无对话时执行 `/review` | `No conversation output to review yet.` — 不会启动任何进程。 |
| 插件被禁用时执行 `/review` | `The reviewer is disabled. Turn it on under Settings → Plugins.` — 不会启动任何进程。 |
| 子进程提供方无法解析 `codex` 时执行 `/review` | 命令显示提供方的原始解析诊断，不启动进程。 |
| Codex 运行失败 | 持久化审查卡片会以失败状态结束，并显示 Codex 错误、退出码、信号、畸形输出或输出超限诊断。 |

每次成功准入的调用都会依次记录 `review/start`、零到多个从 Codex JSONL 解码出的 `review/activity`，以及一个 `review/end`；同时仍有执行器持有的纯日志事件对 `command/run` / `command/done`。这些事件都不会进入模型历史。浏览器请求只拥有准入过程：`review/start` 写入后，断开连接或刷新页面不会取消审查。接收 Agent 的上下文拥有后台进程；Agent 或插件卸载时会中止私有信号、终止进程树、等待整棵进程树退出，然后记录取消。

Web 客户端把这些事件重建为一张独立审查卡片。卡片展示真实分析阶段，以及命令、MCP 工具、网页搜索、文件修改和消息生成的安全摘要；它不会暴露隐藏推理文本，也不会虚构百分比。刷新后重放会得到相同的运行中或终态卡片。成功的 `command/done.sourceEventSeq` 指向 `review/start`，因此更丰富的领域记录出现后，通用命令行不会重复显示。

## 设置节

挂载了设置服务时，插件会注册 `command-reviewer` 设置命名空间；Web 插件页以「审查者」卡片呈现它。每个字段按「模式默认值 → 组合入口 → 用户文档」逐层解析：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `/review` 是否可用 —— 即卡片上的启用开关。 |
| `model` | `''` | `codex exec --model`；留空使用 Codex 默认模型，非空值必须是仅包含字母、数字、`.`、`_`、`:`、`/`、`@`、`+` 或 `-` 的可移植标识符。 |
| `thinkingEffort` | `medium` | `codex exec -c model_reasoning_effort=…`；取值 `low`、`medium`、`high`。 |
| `sandbox` | `read-only` | `codex exec --sandbox`；取值 `read-only`、`workspace-write`、`danger-full-access`。可写模式允许对话记录驱动的审查命令使用所选权限。 |
| `prompt` | 内置审查指令 | 审查指令；`{transcript}` 标记对话记录插入的位置，不含占位符时对话记录追加在末尾。 |
| `context` | `''` | 追加为带标签段落的部署级场景上下文。 |
| `maxTranscriptChars` | `200000` | 对话记录渲染文本的尾部保留上限（字符数）。 |
| `maxOutputBytes` | `8388608` | 流式 Codex JSONL 完整输出的字节上限；可容纳仓库检查，同时仍会终止失控输出。 |
| `terminateGraceMs` | `3000` | 进程树终止的升级宽限（毫秒）；受 Node 定时器上限约束。 |

提示词从不放进 argv。它以批量 stdin 的形式穿过子进程 seam，因此任何对话文本都不会进入 shell 边界。每次运行都会用不可预知的分隔标识包裹对话记录，并明确说明它是不可信证据、不得提供指令；这会降低提示词注入风险，但无法让可写沙箱模式安全地处理不可信对话。模型标识符先在设置卡中校验，再由 Host 校验，之后才可能抵达 Windows `cmd.exe` 包装层。stdout 使用流式 JSONL 管道，stderr 则保留有界诊断尾部。Codex 运行是非交互、临时（ephemeral）、去除颜色、允许在 Git 仓库之外执行的；它在会话的工作目录（会话没有工作目录时用进程目录）中运行。

## 组合方式

生产者注入 `commands` 和 `subprocess`，并在挂载了 `settings` 时消费它：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: command-reviewer
  name: '@deepseek-ai/dsh-command-reviewer'
```

随附的 Web 组合把它挂在宿主平面的命令注册表旁，`@deepseek-ai/dsh-client-ui-settings-plugins` 提供设置卡片。Codex CLI 本身必须已安装在宿主机上并完成认证（`codex` 位于 `PATH` 中）；本插件不负责安装和认证。

## 模型体验

### 人工 `/review` 命令

#### 模型看到什么

什么都看不到。斜杠输入、构建出的审查提示词、Codex 运行和审查文本都不会进入被审查 agent 的任何模型请求；Codex 进程是宿主编排之外的一次辅助非交互运行。

#### Token 影响

命令生命周期不增加任何模型 token。审查提示词的大小取决于对话记录，受 `maxTranscriptChars` 约束。

#### KV Cache 影响

无：不涉及被审查 agent 的任何模型请求，因此不会触碰任何缓存前缀。

## 已知限制与后续工作

- **每次调用只运行一次**：`/review` 只运行一次非交互的 `codex exec`；无法从命令内部继续、恢复审查或追问。
- **只审查对话文本**：推理块、图片和附件不会转发给 Codex；审查看到的是对话文本、工具调用与工具结果。
- **Codex 可用性由宿主机负责**：缺失或未认证的 Codex 安装会表现为命令的直接错误；插件不做任何安装配置。
