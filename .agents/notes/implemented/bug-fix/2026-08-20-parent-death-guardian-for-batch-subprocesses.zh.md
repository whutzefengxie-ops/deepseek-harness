# Agent Note: 批量子进程的父进程死亡 guardian

Status: implemented

[English](2026-08-20-parent-death-guardian-for-batch-subprocesses.md) | 中文

## Problem

本地 subprocess provider 通常会持有 detached 进程树，直到等待式 dispose 或同步 Node `exit` 回调终止该进程树。宿主被强制结束、在 native 代码中 abort，或因其他原因无法继续执行 JavaScript 时，这两条路径都无法运行。普通命令可能继续存活，并保留宿主消失前拥有的文件系统与沙箱权限。只要此前命令仍可能修改工作区，持久化消费方就不能在恢复时安全地把未闭合操作判定为已中断。

外部 supervisor 可以解决该所有权问题，但普通安装式 Node 部署已经具备在本地约束它所需的信息：宿主持有一条私有管道，spawn 出的进程树可以在宿主 JavaScript 之外独立观察该管道关闭。

## Decision

`SubprocessSpawnSpec.hostDeath` 会显式声明宿主丢失后的行为。`'allow'` 接受提供方特有的存活行为，`'terminate'` 则要求提供方在宿主退出无法移除进程树执行能力时，于请求命令启动前拒绝。`dsh-subprocess-local` 会通过一个私有 Node guardian 启动 stdin 为 `ignore` 或完整批量输入、且不在打包单文件运行时中的普通 spawn。guardian 是公共 handle 的受管根。宿主通过 guardian stdin 发送一条 JSON 启动记录，并在 handle 整个生命周期内保留该管道。guardian 使用清理后的环境与请求 cwd 启动指定 argv，转发批量 stdin 与命令 stdout/stderr，并保留命令退出状态。目标侧 stdin 关闭属于被包含的尽力写入失败。在 POSIX 上，guardian 还会在正常进程组 SIGTERM 阶段保持存活，直到目标关闭，再复现目标退出结果；升级阶段的 SIGKILL 仍会移除整个进程组。这两条路径都不能以 guardian 流错误或提前的信号结果替换目标结果。另一条私有状态管道只传递实际命令的 spawn 失败，不会污染命令 stderr。

控制管道意外 EOF 表示所有权丢失。在 POSIX 上，guardian 向自身 detached 进程组发送 SIGKILL；请求命令与普通后代都位于该组，但后代可以通过 `setsid()` 逃离。因此 POSIX 只把 guardian 用作 `hostDeath: 'allow'` 的尽力清理，并在目标启动前拒绝所有 `'terminate'` 请求。在 Windows 上，宿主创建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job，在发送启动记录前把等待中的 guardian 加入其中，并持有唯一的 Job handle。后代会加入该 Job，因此宿主死亡导致 handle 关闭时，Windows 会终止全部成员；这是本地提供方唯一准入 `'terminate'` 的路径。请求命令与 guardian 退出后，Job 成员关系仍让残留后代可观察；正常 `terminate()` 调用 `TerminateJobObject`，`waitForExit()` 等待活动成员数降为零。Job 终止或成员查询失败时，提供方会关闭自有 handle 以触发 kill-on-close 约束，让等待式退出观察 reject，并继续持有进程 handle，直到 service dispose 报告该失败。guardian 的 EOF `taskkill /T /F` 仍是即时的次级档。已有的同步 `exit` 回调继续作为 JavaScript 可观察宿主退出的更快最终档，并继续持有 terminal session。

由调用方持有原始 stdin 管道的运行仍直接 spawn，因为 fd 0 不能同时承载调用方协议与所有权租约。打包单文件运行时也继续直接 spawn，因为其 `process.execPath` 是产品可执行文件，而不是通用 Node 解释器。这些形式以及所有 POSIX 本地 spawn 继续使用提供方文档规定的同步或尽力清理，并拒绝 `hostDeath: 'terminate'`。

## Verification

进程级测试通过真实本地提供方启动一个隔离宿主，以及忽略 TERM 的普通根进程和后代，记录两个受管 pid，再从外部强制结束宿主。该场景覆盖 POSIX guardian 的尽力进程组清理与 Windows 保证，但不会声称 POSIX 目标无法守护化。聚焦拒绝测试会选择 POSIX 分支、请求 `'terminate'`，并证明写入标记文件的目标从未启动。Windows 原生用例让请求根正常退出，同时保留一个 detached 后代：`done` 会结算，有界 `waitForExit()` 会报告仍存在的 Job 成员，正常终止则会将其移除。同一套件还证明 guardian 保留批量 stdin、收集的 stdout、非零目标退出状态与目标 spawn 错误，并覆盖普通宿主退出清理和正常的先终止再等待退出 dispose。直接 guardian 回归会在大批量写入仍待处理时关闭目标 stdin，并让目标捕获进程组 SIGTERM 后以零退出；两种场景都要求目标后续退出结果保持权威。

`/review` 命令使用完整批量 stdin，要求 `hostDeath: 'terminate'`，并把该要求持久化到 `review/start.request`。因此本地提供方只在 Windows 运行它。启动记录会在 Job 持有的 spawn 前到达 Session 持久化检查点，所以恢复出的未闭合审查表示此前宿主既已持久化该操作，也已在提供方保证下准入；该保证已经移除旧 Codex 进程树的执行能力。POSIX 部署需要由 cgroup、supervisor 或等价所有权机制支撑的其他子进程提供方。

## Alternatives considered

**持久化进程 pid，并在恢复时终止。** 拒绝，因为裸 pid 可以复用，而完整的跨平台进程身份与后代租约会重复本地提供方已有的所有权机制。恢复前命令还会一直存活，直到另一个宿主打开该精确会话。

**只安装信号 handler。** 拒绝，因为 SIGKILL、native abort 与若干致命运行时故障无法执行 handler。

**要求每个普通 spawn 都依赖外部 supervisor。** 对 `'allow'` 命令不采用，因为安装式 Node 提供方可以通过继承管道执行有价值的进程组清理，无需部署专用设置。POSIX `'terminate'`、被排除的进程形式与运行机器之外的故障仍需要外部所有权。

**声称 POSIX guardian 能约束守护化后代。** 拒绝，因为进程组成员关系在启动后是自愿的：`setsid()` 会创建新会话和进程组。本地提供方没有可移植的 cgroup 或 macOS supervisor 能力来替代这项内核所有权事实。

**让原始交互 stdin 也经过 guardian。** 暂缓，因为透明的全双工代理会增加背压、半关闭与错误顺序行为，而当前没有恢复敏感的消费方需要它。直接路径会保留公共 pipe 约定。

## Consequences

一个 stdin 为 ignore 或批量输入的普通命令会增加一个轻量 Node guardian 进程与一条私有状态管道；Windows 还会增加一个由宿主持有的内核 Job Object。handle pid 标识 guardian 进程树根，而不是请求的可执行文件。命令 stdout、stderr、退出状态、终止与整树等待保留原有公共含义。Windows 可以准入宿主死亡后无存活进程的要求。POSIX 对 `'allow'` 保留尽力进程组清理，并在目标启动前拒绝 `'terminate'`，因此恢复敏感的消费方不会依赖可被 daemon 逃逸的虚假保证。
