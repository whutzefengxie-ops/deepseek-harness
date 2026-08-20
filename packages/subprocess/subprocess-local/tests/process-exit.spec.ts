import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { createProcessInspector } from '../src/process-inspector.ts'
import type { ProcessIdentity, ProcessInspector } from '../src/process-inspector.ts'
import { spawnSubprocess, taskkillProcessTree } from '../src/spawn.ts'

type ExitTrigger = 'direct' | 'uncaught-exception' | 'unhandled-rejection' | 'dispose' | 'external-kill'
type ManagedKind = 'ordinary' | 'terminal'
interface TreeState { root: number; descendant: number }

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const hostScript = fileURLToPath(new URL('./fixtures/process-exit-host.ts', import.meta.url))
const scenarioTimeoutMs = 30_000

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function readTree(path: string): Promise<TreeState> {
  return vi.waitFor(async () => {
    const text = await readFile(path, 'utf8')
    const state = JSON.parse(text) as Partial<TreeState>
    if (!Number.isSafeInteger(state.root) || !Number.isSafeInteger(state.descendant)
      || (state.root ?? 0) <= 0 || (state.descendant ?? 0) <= 0 || state.root === state.descendant) {
      throw new Error(`invalid managed-tree state: ${text}`)
    }
    return state as TreeState
  }, { interval: 10, timeout: scenarioTimeoutMs })
}

async function captureIdentities(inspector: ProcessInspector, state: TreeState): Promise<ProcessIdentity[]> {
  return vi.waitFor(() => {
    const expected = new Set([state.root, state.descendant])
    const identities = inspector.processTree(state.root).filter(identity => expected.has(identity.pid))
    if (identities.length !== expected.size) throw new Error('managed tree is not fully observable yet')
    return identities
  }, { interval: 10, timeout: scenarioTimeoutMs })
}

async function waitForGone(state: TreeState): Promise<void> {
  await Promise.all([state.root, state.descendant].map(pid => vi.waitFor(() => {
    if (processExists(pid)) throw new Error(`managed pid ${pid} is still alive`)
  }, { interval: 25, timeout: 10_000 })))
}

function cleanupTree(state: TreeState | undefined, identities: ProcessIdentity[]): void {
  if (state === undefined) return
  if (process.platform === 'win32') {
    taskkillProcessTree(state.root)
    for (const pid of [state.descendant, state.root]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (_alreadyGone) {
        // The exact recorded process already exited.
      }
    }
    return
  }
  const inspector = createProcessInspector()
  for (const identity of identities) {
    try {
      inspector.signalProcess(identity, 'SIGKILL')
    } catch (_alreadyGone) {
      // Exact start identity prevents PID-reuse cleanup from reaching another process.
    }
  }
  if (identities.length === 0) {
    for (const pid of [state.descendant, state.root]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (_alreadyGone) {
        // The scenario failed before process identities became observable.
      }
    }
  }
}

async function runScenario(kind: ManagedKind, trigger: ExitTrigger) {
  const root = await mkdtemp(join(tmpdir(), `dsh-subprocess-host-exit-${kind}-${trigger}-`))
  const launch = resolveExampleLaunch({
    srcBin: hostScript,
    mode: 'src',
    tsconfigPath: join(repoRoot, 'tsconfig.json'),
    configArgs: [kind, trigger, root],
  })
  const child = execa(launch.command, launch.args, {
    cwd: repoRoot,
    env: launch.env,
    stdin: 'ignore',
    reject: false,
    timeout: scenarioTimeoutMs,
  })
  let state: TreeState | undefined
  let identities: ProcessIdentity[] = []
  let settled = false
  let treeGone = false
  try {
    // The host validates tree.json before waiting for proceed, so observing it
    // is sufficient readiness; a second marker only adds a redundant Windows poll.
    state = await readTree(join(root, 'tree.json'))
    if (process.platform !== 'win32') identities = await captureIdentities(createProcessInspector(), state)
    await writeFile(join(root, 'proceed'), 'proceed')
    if (trigger === 'external-kill') child.kill('SIGKILL')
    const outcome = await child
    settled = true
    await waitForGone(state)
    treeGone = true
    const disposeCounts = trigger === 'dispose'
      ? JSON.parse(await readFile(join(root, 'dispose.json'), 'utf8')) as {
        listenersBefore: number
        listenersAfterLoad: number
        listenersAfterDispose: number
      }
      : undefined
    return { outcome, disposeCounts }
  } finally {
    if (!settled) {
      child.kill('SIGKILL')
      await child.catch(() => {})
    }
    if (!treeGone) {
      cleanupTree(state, identities)
      if (state !== undefined) await waitForGone(state).catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe('synchronous cleanup on host exit', () => {
  it.each([
    { trigger: 'direct' as const, expectedCode: 23, diagnostic: undefined },
    { trigger: 'uncaught-exception' as const, expectedCode: 1, diagnostic: 'host-exit-uncaught-exception' },
    { trigger: 'unhandled-rejection' as const, expectedCode: 1, diagnostic: 'host-exit-unhandled-rejection' },
  ])('removes an ordinary managed tree after $trigger', { timeout: 45_000 }, async ({
    trigger,
    expectedCode,
    diagnostic,
  }) => {
    const { outcome } = await runScenario('ordinary', trigger)
    expect(outcome.exitCode).toBe(expectedCode)
    expect(outcome.signal).toBeUndefined()
    if (diagnostic !== undefined) expect(outcome.stderr).toContain(diagnostic)
  })

  it.skipIf(process.platform === 'win32')(
    'removes a terminal root and descendant after direct exit',
    { timeout: 45_000 },
    async () => {
      const { outcome } = await runScenario('terminal', 'direct')
      expect(outcome.exitCode).toBe(23)
      expect(outcome.signal).toBeUndefined()
    },
  )

  it('removes an ordinary managed tree after the Host is force-killed externally', { timeout: 45_000 }, async () => {
    const { outcome } = await runScenario('ordinary', 'external-kill')
    expect(outcome.failed).toBe(true)
  })

  it('preserves normal terminate-and-join disposal and removes the exit listener', { timeout: 45_000 }, async () => {
    const { outcome, disposeCounts } = await runScenario('ordinary', 'dispose')
    expect(outcome.exitCode).toBe(0)
    expect(disposeCounts?.listenersAfterLoad).toBe((disposeCounts?.listenersBefore ?? 0) + 1)
    expect(disposeCounts?.listenersAfterDispose).toBe(disposeCounts?.listenersBefore)
  })
})

describe('parent-death guardian command transport', () => {
  it('reports guardian allocation failures through the handle', async () => {
    const missingCwd = await mkdtemp(join(tmpdir(), 'dsh-subprocess-missing-cwd-'))
    await rm(missingCwd, { recursive: true, force: true })
    const handle = spawnSubprocess({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: missingCwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1_024 },
        stderr: { maxBytes: 1_024 },
      },
      hostDeath: 'terminate',
      graceMs: 100,
    })

    await expect(handle.done).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('preserves batch stdin, stdout, and the target exit code', async () => {
    const handle = spawnSubprocess({
      argv: [process.execPath, '-e', 'const fs=require("node:fs");let text="";process.stdin.on("data",chunk=>{text+=chunk});process.stdin.on("end",()=>{fs.writeSync(1,text);process.exit(19)})'],
      cwd: process.cwd(),
      stdio: {
        stdin: { data: 'guardian transport\n' },
        stdout: { maxBytes: 1_024 },
        stderr: { maxBytes: 1_024 },
      },
      hostDeath: 'terminate',
      graceMs: 100,
    })

    const outcome = await handle.done
    expect(outcome).toEqual({ exitCode: 19, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('guardian transport\n')
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('reports an actual-command spawn error through done', async () => {
    const missing = join(tmpdir(), `dsh-missing-command-${process.pid}-${Date.now()}`)
    const handle = spawnSubprocess({
      argv: [missing],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1_024 },
        stderr: { maxBytes: 1_024 },
      },
      hostDeath: 'terminate',
      graceMs: 100,
    })

    await expect(handle.done).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('Windows guardian Job ownership', () => {
  it('retains and terminates descendants after the requested command exits normally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-subprocess-windows-job-'))
    const pidFile = join(root, 'descendant.pid')
    let descendant: number | undefined
    const handle = spawnSubprocess({
      argv: [process.execPath, '-e', [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" })',
        'writeFileSync(process.argv[1], String(child.pid))',
        'child.unref()',
      ].join(';'), pidFile],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1_024 },
        stderr: { maxBytes: 1_024 },
      },
      hostDeath: 'terminate',
      graceMs: 100,
    })

    try {
      descendant = await vi.waitFor(async () => {
        const pid = Number((await readFile(pidFile, 'utf8')).trim())
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('descendant pid is not ready')
        return pid
      }, { interval: 10, timeout: 5_000 })
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(processExists(descendant)).toBe(true)
      await expect(handle.waitForExit(AbortSignal.timeout(100))).resolves.toBe(false)

      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)
      await vi.waitFor(() => {
        if (processExists(descendant!)) throw new Error('descendant remains alive')
      }, { interval: 25, timeout: 5_000 })
    } finally {
      handle.terminate()
      if (descendant !== undefined && processExists(descendant)) {
        try { process.kill(descendant, 'SIGKILL') } catch { /* The Job already removed it. */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
