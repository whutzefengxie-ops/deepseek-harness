# Agent Note: Parent-death guardian for batch subprocesses

Status: implemented

English | [中文](2026-08-20-parent-death-guardian-for-batch-subprocesses.zh.md)

## Problem

The local subprocess provider normally owns a detached process tree until awaited disposal or its synchronous Node `exit` callback terminates that tree. Neither path can run when the Host is force-killed, aborts in native code, or otherwise loses JavaScript execution. An ordinary command can then remain alive with the same filesystem and sandbox authority it had before the Host disappeared. A durable consumer cannot safely recover an open operation as interrupted while the prior command may still be modifying the workspace.

External supervision can solve that ownership problem, but ordinary installed Node deployments already have enough information to contain it locally: the Host controls a private pipe, and the spawned tree can observe that pipe closing independently of Host JavaScript.

## Decision

`SubprocessSpawnSpec.hostDeath` makes Host-loss behavior explicit. `'allow'` accepts provider-specific survivors, while `'terminate'` requires the provider to reject before the requested command starts unless Host exit removes the tree's execution ability. `dsh-subprocess-local` routes ordinary non-packaged spawns whose stdin is `ignore` or a complete batch through a private Node guardian. The guardian is the public handle's managed root. The Host sends one JSON launch record through the guardian's stdin and retains that pipe for the handle lifetime. The guardian starts the requested argv with the scrubbed environment and requested cwd, forwards batch stdin and the command's stdout/stderr, and preserves the command exit status. Target-side stdin closure is a contained best-effort write failure, so it cannot replace that target outcome with an unhandled guardian stream error. A separate private status pipe carries target-spawn failures without contaminating command stderr.

Unexpected control-pipe EOF is an ownership-loss event. On POSIX the guardian sends SIGKILL to its own detached process group, which contains the requested command and ordinary descendants, but a descendant can call `setsid()` and escape that group. POSIX therefore uses this guardian only as best-effort cleanup for `hostDeath: 'allow'` and rejects every `'terminate'` request before launching the target. On Windows the Host creates a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job, assigns the waiting guardian before sending its launch record, and retains the only Job handle. Descendants join the Job, so Windows terminates them when Host death closes that handle; this is the local provider's only `'terminate'` admission path. Job membership also keeps residual descendants observable after the requested command and guardian exit; normal `terminate()` calls `TerminateJobObject`, and `waitForExit()` waits for the active-member count to reach zero. A Job termination or membership-query failure closes the owned handle to activate kill-on-close containment, rejects the awaited exit observation, and keeps the process handle owned until service disposal reports the failure. The guardian's EOF `taskkill /T /F` remains an immediate secondary tier. The existing synchronous `exit` callback remains a faster final tier for JavaScript-observable Host exits and continues to own terminal sessions.

Raw caller-owned stdin pipes stay on the direct spawn path because fd 0 cannot simultaneously carry the caller protocol and the ownership lease. Packaged single-file runtimes also stay direct because their `process.execPath` is the product executable rather than a general Node interpreter. Those forms and every POSIX local spawn retain the synchronous or best-effort cleanup documented by the provider and reject `hostDeath: 'terminate'`.

## Verification

A process-level test starts an isolated Host and a TERM-resistant ordinary root plus descendant through the real local provider, records both managed pids, then force-kills the Host externally. This exercises the guardian's POSIX best-effort group cleanup and the Windows guarantee without claiming that the POSIX target cannot daemonize. A focused rejection test selects the POSIX branch, requests `'terminate'`, and proves a marker-writing target never starts. A Windows-native case lets the requested root exit normally while a detached descendant remains: `done` settles, a bounded `waitForExit()` reports the live Job member, and normal termination removes it. The same suite proves that the guardian preserves batch stdin, collected stdout, nonzero target exit status, target-spawn errors, ordinary Host exit cleanup, and normal terminate-and-join disposal. A direct guardian regression closes target stdin during a large pending batch write and requires the target's later exit status to remain authoritative.

The `/review` command uses complete batch stdin, requires `hostDeath: 'terminate'`, and persists that requirement in `review/start.request`. The local provider therefore runs it only on Windows. Its start record reaches the Session durability checkpoint before the Job-owned spawn, so a resumed open review means the prior Host both persisted the operation and admitted it under a provider guarantee that has removed the prior Codex tree's execution ability. A POSIX deployment needs another subprocess provider backed by cgroups, a supervisor, or an equivalent ownership mechanism.

## Alternatives considered

**Persist process ids and kill them during recovery.** Rejected because a bare pid is reusable and a complete cross-platform process identity plus descendant lease would duplicate the local provider's existing ownership machinery. Recovery would also leave the command active until another Host opened that exact Session.

**Install signal handlers only.** Rejected because SIGKILL, native aborts, and several fatal runtime failures cannot execute a handler.

**Require an external supervisor for every ordinary spawn.** Rejected for `'allow'` commands because the installed Node provider can perform useful group cleanup through the inherited pipe without deployment-specific setup. External ownership remains necessary for POSIX `'terminate'`, excluded process forms, and failures outside the running machine.

**Claim the POSIX guardian contains daemonized descendants.** Rejected because process-group membership is voluntary after launch: `setsid()` creates a new session and group. The local provider has no portable cgroup or macOS supervisor capability to replace that kernel ownership fact.

**Route raw interactive stdin through the guardian.** Deferred because transparent full-duplex proxying adds backpressure, half-close, and error-ordering behavior that no current recovery-sensitive consumer needs. The direct path preserves the public pipe contract.

## Consequences

An ordinary ignored-stdin or batch command adds one lightweight Node guardian process and a private status pipe; Windows also adds one kernel Job Object owned by the Host. The handle pid identifies the guardian tree root rather than the requested executable. Command stdout, stderr, exit status, termination, and whole-tree waits retain their public meanings. Windows can admit the no-survivor Host-death requirement. POSIX keeps best-effort group cleanup for `'allow'` and fails `'terminate'` before the target starts, so recovery-sensitive consumers never rely on a daemon-escape-prone guarantee.
