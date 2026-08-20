# Agent Note: Parent-death guardian for batch subprocesses

Status: implemented

English | [中文](2026-08-20-parent-death-guardian-for-batch-subprocesses.zh.md)

## Problem

The local subprocess provider normally owns a detached process tree until awaited disposal or its synchronous Node `exit` callback terminates that tree. Neither path can run when the Host is force-killed, aborts in native code, or otherwise loses JavaScript execution. An ordinary command can then remain alive with the same filesystem and sandbox authority it had before the Host disappeared. A durable consumer cannot safely recover an open operation as interrupted while the prior command may still be modifying the workspace.

External supervision can solve that ownership problem, but ordinary installed Node deployments already have enough information to contain it locally: the Host controls a private pipe, and the spawned tree can observe that pipe closing independently of Host JavaScript.

## Decision

`dsh-subprocess-local` starts every ordinary non-packaged spawn whose stdin is `ignore` or a complete batch through a private Node guardian. The guardian is the public handle's managed root. The Host sends one JSON launch record through the guardian's stdin and retains that pipe for the handle lifetime. The guardian starts the requested argv with the scrubbed environment and requested cwd, forwards batch stdin and the command's stdout/stderr, and preserves the command exit status. A separate private status pipe carries target-spawn failures without contaminating command stderr.

Unexpected control-pipe EOF is an ownership-loss event. On POSIX the guardian sends SIGKILL to its own detached process group, which contains the requested command and ordinary descendants. On Windows it synchronously runs `taskkill /PID <command-pid> /T /F` before exiting. Normal `terminate()` still signals the guardian-rooted tree through the provider's existing TERM-to-KILL ladder, and `waitForExit()` still observes that complete tree. The existing synchronous `exit` callback remains a faster final tier for JavaScript-observable Host exits and continues to own terminal sessions.

Raw caller-owned stdin pipes stay on the direct spawn path because fd 0 cannot simultaneously carry the caller protocol and the ownership lease. Packaged single-file runtimes also stay direct because their `process.execPath` is the product executable rather than a general Node interpreter. Those forms retain the synchronous cleanup and external-supervisor requirements documented by the provider.

## Verification

A process-level test starts an isolated Host and a TERM-resistant root plus descendant through the real local provider, records both managed pids, then force-kills the Host externally. The parent test waits for both managed processes to disappear. The same suite proves that the guardian preserves batch stdin, collected stdout, nonzero target exit status, target-spawn errors, ordinary Host exit cleanup, and normal terminate-and-join disposal.

The `/review` command uses complete batch stdin. Its start record reaches the Session durability checkpoint before this guarded spawn, so a resumed open review means the prior Host both persisted the operation and subsequently lost ownership; the guardian has terminated that prior Codex tree.

## Alternatives considered

**Persist process ids and kill them during recovery.** Rejected because a bare pid is reusable and a complete cross-platform process identity plus descendant lease would duplicate the local provider's existing ownership machinery. Recovery would also leave the command active until another Host opened that exact Session.

**Install signal handlers only.** Rejected because SIGKILL, native aborts, and several fatal runtime failures cannot execute a handler.

**Require an external supervisor for every ordinary spawn.** Rejected as the only solution because the installed Node provider can tie the command lifetime to an inherited pipe without deployment-specific setup. External ownership remains necessary for excluded process forms and failures outside the running machine.

**Route raw interactive stdin through the guardian.** Deferred because transparent full-duplex proxying adds backpressure, half-close, and error-ordering behavior that no current recovery-sensitive consumer needs. The direct path preserves the public pipe contract.

## Consequences

An ordinary ignored-stdin or batch command adds one lightweight Node guardian process and a private status pipe. The handle pid identifies the guardian tree root rather than the requested executable. Command stdout, stderr, exit status, termination, and whole-tree waits retain their public meanings. A force-killed ordinary Host no longer leaves these guarded local commands running, while terminal, raw-stdin-pipe, packaged-runtime, daemon escape, and machine-loss limitations remain explicit.
