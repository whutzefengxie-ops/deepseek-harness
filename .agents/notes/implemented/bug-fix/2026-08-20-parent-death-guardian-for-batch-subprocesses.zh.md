# Agent Note: 批量子进程的父进程死亡 guardian

Status: implemented

[English](2026-08-20-parent-death-guardian-for-batch-subprocesses.md) | 中文

## Problem

本地 subprocess provider 通常会持有 detached 进程树，直到等待式 dispose 或同步 Node `exit` 回调终止该进程树。宿主被强制结束、在 native 代码中 abort，或因其他原因无法继续执行 JavaScript 时，这两条路径都无法运行。普通命令可能继续存活，并保留宿主消失前拥有的文件系统与沙箱权限。只要此前命令仍可能修改工作区，持久化消费方就不能在恢复时安全地把未闭合操作判定为已中断。

外部 supervisor 可以解决该所有权问题，但普通安装式 Node 部署已经具备在本地约束它所需的信息：宿主持有一条私有管道，spawn 出的进程树可以在宿主 JavaScript 之外独立观察该管道关闭。

## Decision

`dsh-subprocess-local` 会通过一个私有 Node guardian 启动每个 stdin 为 `ignore` 或完整批量输入、且不在打包单文件运行时中的普通 spawn。guardian 是公共 handle 的受管根。宿主通过 guardian stdin 发送一条 JSON 启动记录，并在 handle 整个生命周期内保留该管道。guardian 使用清理后的环境与请求 cwd 启动指定 argv，转发批量 stdin 与命令 stdout/stderr，并保留命令退出状态。另一条私有状态管道只传递实际命令的 spawn 失败，不会污染命令 stderr。

控制管道意外 EOF 表示所有权丢失。在 POSIX 上，guardian 向自身 detached 进程组发送 SIGKILL；请求命令与普通后代都位于该组。在 Windows 上，guardian 会在退出前同步运行 `taskkill /PID <command-pid> /T /F`。正常 `terminate()` 仍通过提供方已有的 TERM 到 KILL 阶梯向以 guardian 为根的进程树发送信号，`waitForExit()` 仍观察完整进程树。已有的同步 `exit` 回调继续作为 JavaScript 可观察宿主退出的更快最终档，并继续持有 terminal session。

由调用方持有原始 stdin 管道的运行仍直接 spawn，因为 fd 0 不能同时承载调用方协议与所有权租约。打包单文件运行时也继续直接 spawn，因为其 `process.execPath` 是产品可执行文件，而不是通用 Node 解释器。这些形式继续遵守提供方文档中的同步清理与外部 supervisor 要求。

## Verification

进程级测试通过真实本地提供方启动一个隔离宿主，以及忽略 TERM 的根进程和后代，记录两个受管 pid，再从外部强制结束宿主。父测试会等待两个受管进程全部消失。同一套件还证明 guardian 保留批量 stdin、收集的 stdout、非零目标退出状态与目标 spawn 错误，并覆盖普通宿主退出清理和正常的先终止再等待退出 dispose。

`/review` 命令使用完整批量 stdin。它的启动记录在受 guardian 保护的 spawn 前到达 Session 持久化检查点，因此恢复出的未闭合审查表示此前宿主既已持久化该操作，之后又丢失所有权；guardian 已经终止此前的 Codex 进程树。

## Alternatives considered

**持久化进程 pid，并在恢复时终止。** 拒绝，因为裸 pid 可以复用，而完整的跨平台进程身份与后代租约会重复本地提供方已有的所有权机制。恢复前命令还会一直存活，直到另一个宿主打开该精确会话。

**只安装信号 handler。** 拒绝，因为 SIGKILL、native abort 与若干致命运行时故障无法执行 handler。

**要求每个普通 spawn 都依赖外部 supervisor。** 不接受将其作为唯一方案，因为安装式 Node 提供方可以通过继承管道绑定命令生命周期，无需部署专用设置。被排除的进程形式与运行机器之外的故障仍需要外部所有权。

**让原始交互 stdin 也经过 guardian。** 暂缓，因为透明的全双工代理会增加背压、半关闭与错误顺序行为，而当前没有恢复敏感的消费方需要它。直接路径会保留公共 pipe 约定。

## Consequences

一个 stdin 为 ignore 或批量输入的普通命令会增加一个轻量 Node guardian 进程与一条私有状态管道。handle pid 标识 guardian 进程树根，而不是请求的可执行文件。命令 stdout、stderr、退出状态、终止与整树等待保留原有公共含义。普通宿主被强制结束后，不再遗留这些受保护的本地命令；terminal、原始 stdin pipe、打包运行时、daemon 逃逸与机器丢失限制仍保持显式。
