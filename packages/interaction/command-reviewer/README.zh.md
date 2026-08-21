# @deepseek-ai/dsh-command-reviewer

[English](README.md) | 中文

面向本地 Codex CLI 的人工 `/review` 命令（审查者）。该插件通过 [`ctx.commands`](../../interaction/commands/README.zh.md) 注册一个全局命令，因此所有已组合的命令适配器都能发现并执行它，而不占用模型回合。每次运行都会把接收会话推导出的对话投影为一份审查提示词，通过 [`ctx.subprocess`](../../subprocess/subprocess/README.zh.md) 启动一次非交互的 `codex exec --json`，立即确认持久化的启动记录，并把真实 Codex 进度与最终审查结果写入会话日志。

## 命令约定

每条记录的活动都属于真实 Codex 条目，并将其外部 id 存为 `item:<id>`。该 id 的重复事件必须保持同一个活动类别。顶层 turn 生命周期记录会被忽略，因为它们并不标识独立的公开操作。

| 输入 | 结果 |
|---|---|
| `/review` | 启动一次针对当前对话的 Codex 审查，并立即清空提交输入框。 |
| `/review <关注点>` | 同上，关注点会作为带标签的段落追加到提示词中，并显示在审查卡片上。 |
| 尚无对话时执行 `/review` | `No conversation output to review yet.` — 不会启动任何进程。 |
| 插件被禁用时执行 `/review` | `The reviewer is disabled. Turn it on under Settings → Plugins.` — 不会启动任何进程。 |
| 当前 Agent 的活动审查数已达到 `maxConcurrentReviews` 时执行 `/review` | 显示活动数量与配置上限，不会启动第二个进程。 |
| 组装后的提示词超过 `maxPromptBytes` 时执行 `/review` | 显示实际 UTF-8 字节数与配置上限；不会启动进程，也不会记录 `review/start`。 |
| 子进程提供方无法解析 `codex` 时执行 `/review` | 命令显示提供方的原始解析诊断，不启动进程。 |
| 在显式组合中于 POSIX 上使用本地提供方执行 `/review` | 准入后输入框会清空，随后持久卡片以 `The review could not start: subprocess-local: host-death termination requires Windows Job Object ownership` 失败；Codex 不会启动。随附 Web 组合不挂载这条不受支持的命令。 |
| Codex 运行失败 | 持久化审查卡片会以失败状态结束，并显示所有已观察到的 Codex 错误、超时、退出码或信号、畸形输出诊断和输出超限诊断；后续失败前已解码出的最终审查文本会保留在这些诊断上方。 |

每次成功准入的调用都会依次记录 `review/start`、零到多个从 Codex JSONL 解码出的 `review/activity`，以及一个 `review/end`；同时仍有执行器持有的纯日志事件对 `command/run` / `command/done`。每条终态记录都包含至少一个非空白字符的结果或诊断。该命令关闭通用输入记录，因此 `command/run` 省略 `args`；`review/start.focus` 是成功准入后关注点的唯一持久副本。`review/start.request` 保存本次 Codex 请求实际使用的完整提示词、规范 argv、显式子进程环境项、工作目录、必需的 `hostDeath: "terminate"` 行为与运行超时。对话记录会排除指令、目录和运行时快照上下文，避免把这些配置误记为用户对话；直接消息、模型输出、工具活动、通知、转发、召回和压缩摘要仍作为审查证据。这些事件都不会进入被审查 Agent 的模型历史。处理器会在写入 `review/start` 前立即提交请求准入，要求会话存储执行 flush，再从 `ctx.sessionPersistence` 的新事件序号开始读取；只有存储事件与该 `review/start` 完全匹配时才会启动 Codex。持久化后端缺失、失败或记录不完整都会阻止启动，并在存储恢复后发布失败终态。准入完成后，断开连接或刷新页面不会取消审查。接收 Agent 的上下文拥有后台进程；超时、Agent 卸载或插件卸载都会终止进程树，并等待整棵进程树退出后再记录终态。如果子进程 spawn 同步触发所有者卸载后再抛出异常，审查会按所有者取消结算，而不是记为启动失败。只有从持久化存储精确读回 `review/end` 后才会释放并发名额。退出确认、终态追加或终态持久化失败都会让运行继续由所有者持有，并让卸载显式报告失败。无法在自身宿主退出时终止进程树的子进程提供方会在 Codex 启动前拒绝。随附的本地提供方只通过 Windows kill-on-close Job Object 准入该要求；其 POSIX guardian 无法约束 `setsid()` 后代，因此会在 Codex 启动前拒绝。后续宿主恢复会话时，恢复逻辑会为每个缺少命令确认的 `review/start` 补充一条指向该启动事件的成功 `command/done`，包括已经存在终态的审查。只有非 fork 的开放审查才会继续追加一条 `interrupted` 终态；持久化保证表明其旧进程树已经失去执行能力。fork 继承开放审查时，子会话会改为记录该运行没有在 fork 中继续，源会话保持不变。压缩仍在同一会话与所有者中进行，不会迁移或结束审查。

Web 客户端把这些事件重建为一张独立审查卡片。卡片会本地化类别，并显示真实 Codex 推理、命令、MCP 工具、网页搜索、文件修改和消息生成的安全条目摘要；它不会暴露隐藏推理文本，也不会虚构百分比。刷新后重放会得到相同的运行中或终态卡片；恢复或 fork 继承出的未闭合审查会显示为「已中断」，并携带已记录的原因。成功的 `command/done.sourceEventSeq` 指向 `review/start`，审查节点还会认领带品牌类型的命令身份，因此分页窗口尚未加载该启动事件时，通用命令行仍不会重复显示。

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
| `maxTranscriptChars` | `200000` | 按 Unicode code point 计算的尾部保留上限；渲染过程增量统计输入，并且只持有这段有界尾部。 |
| `maxPromptBytes` | `1048576` | 指令、对话记录保护、上下文与关注点全部组装后，完整提示词的 UTF-8 字节上限。 |
| `maxOutputBytes` | `8388608` | 流式 Codex JSONL 完整输出的字节上限；可容纳仓库检查，同时仍会终止失控输出。 |
| `terminateGraceMs` | `3000` | 进程树终止的升级宽限（毫秒）；受 Node 定时器上限约束。 |
| `timeoutMs` | `3600000` | 单次审查的最长运行时间（毫秒）；超时后终止进程树，且受 Node 定时器上限约束。 |
| `maxConcurrentReviews` | `1` | 同一 Agent 可同时持有的活动审查数量上限。 |

提示词从不放进 argv。它以批量 stdin 的形式穿过子进程 seam，因此任何对话文本都不会进入 shell 边界。每次运行都会用不可预知的分隔标识包裹对话记录，并明确说明它是不可信证据、不得提供指令；这会降低提示词注入风险，但无法让可写沙箱模式安全地处理不可信对话。完整 UTF-8 提示词会在持久化或进程准入前按 `maxPromptBytes` 检查。Codex 使用当前子进程提供方返回的规范路径启动。如果该路径是 Windows 批处理包装器，提供方还会解析 `cmd.exe`；argv 使用 `/d /q /v:off /s /c` 并展开 `DSH_CODEX_REVIEWER_EXECUTABLE`，显式子进程环境则携带加引号的规范包装器路径。该形式可以保留包含空格和命令元字符的路径，同时不会把对话文本放进 shell 命令。模型标识符会在进入解释器前完成校验。stdout 使用流式 JSONL 管道，stderr 则保留有界诊断尾部。Codex 运行是非交互、临时（ephemeral）、去除颜色、允许在 Git 仓库之外执行的；它在会话的工作目录（会话没有工作目录时用进程目录）中运行。

## 组合方式

生产者注入 `commands`、`sessions`、`sessionPersistence` 和 `subprocess`，并在挂载了 `settings` 时消费它：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: './.sessions'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: command-reviewer
  name: '@deepseek-ai/dsh-command-reviewer'
```

随附的 Web 组合只在 Windows 宿主平面把它挂到命令注册表旁，`@deepseek-ai/dsh-client-ui-settings-plugins` 提供设置卡片。POSIX 默认省略该行，因为随附提供方无法满足其宿主死亡要求；拥有等价提供方的部署可以显式组合本包。Codex CLI 本身必须已安装在宿主机上（`codex` 位于 `PATH` 中），并在子进程提供方的执行环境中通过持久登录完成认证；本插件不负责安装和认证。本地子进程提供方会移除名称包含 `KEY`、`TOKEN`、`SECRET` 或 `PASSWORD` 的环境变量，本插件也不会授权 API 凭据进入子进程环境。

## 模型体验

### 人工 `/review` 命令

#### 模型看到什么

什么都看不到。斜杠输入、构建出的审查提示词、Codex 运行和审查文本都不会进入被审查 agent 的任何模型请求；Codex 进程是宿主编排之外的一次辅助非交互运行。

#### Token 影响

命令生命周期不增加任何模型 token。`maxTranscriptChars` 限制对话记录尾部，`maxPromptBytes` 限制完整审查提示词。

#### KV Cache 影响

无：不涉及被审查 agent 的任何模型请求，因此不会触碰任何缓存前缀。

## 已知限制与后续工作

- **每次调用只运行一次**：`/review` 只运行一次非交互的 `codex exec`；无法从命令内部继续、恢复审查或追问。
- **只审查对话文本**：指令、目录和运行时快照上下文、推理块、图片与附件不会转发给 Codex；审查看到的是对话文本、工具调用与工具结果。
- **部署必须提供 Codex 可执行文件与持久登录**：缺少可执行文件会直接导致命令准入失败；spawn 后的认证失败会让持久化审查卡片以「失败」结束。如果认证只存在于环境变量形式的 API key 中，随附本地子进程提供方会按敏感环境变量清洗规则移除该值，因此审查进程无法使用它。
- **随附本地提供方的宿主死亡保证仅支持 Windows**：默认 Web profile 在 POSIX 上不挂载 `/review`；显式 POSIX 组合需要由 cgroup、supervisor 或其他能够约束守护化后代的所有权机制支撑子进程提供方。
