import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PARENT_DEATH_GUARDIAN_SOURCE } from '../src/parent-death-guardian.ts'

describe('parent-death guardian batch stdin', () => {
  it('reports the target exit when the target closes its stdin during a large write', async () => {
    const guardian = spawn(process.execPath, ['-e', PARENT_DEATH_GUARDIAN_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    guardian.stderr.setEncoding('utf8')
    guardian.stderr.on('data', (chunk: string) => { stderr += chunk })
    ;(guardian.stdio[3] as Readable).resume()
    guardian.stdin.on('error', () => { /* A failing guardian can close the control pipe before the assertion. */ })

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      guardian.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    guardian.stdin.write(`${JSON.stringify({
      argv: [
        process.execPath,
        '-e',
        'process.stdin.destroy(); setTimeout(() => process.exit(7), 200)',
      ],
      stdin: 'x'.repeat(16 * 1024 * 1024),
    })}\n`)

    await expect(closed).resolves.toEqual({ code: 7, signal: null })
    expect(stderr).toBe('')
  }, 10_000)

  it.skipIf(process.platform === 'win32')('preserves a target exit after graceful group termination', async () => {
    const guardian = spawn(process.execPath, ['-e', PARENT_DEATH_GUARDIAN_SOURCE], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    const targetReady = new Promise<void>((resolve) => {
      guardian.stdout.setEncoding('utf8')
      guardian.stdout.once('data', () => { resolve() })
    })
    ;(guardian.stdio[3] as Readable).resume()
    guardian.stdin.on('error', () => { /* A failing guardian can close the control pipe before the assertion. */ })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      guardian.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    guardian.stdin.write(`${JSON.stringify({
      argv: [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 60_000)",
      ],
    })}\n`)
    await targetReady
    const pid = guardian.pid
    if (pid === undefined) throw new Error('guardian pid is missing')
    process.kill(-pid, 'SIGTERM')

    await expect(closed).resolves.toEqual({ code: 0, signal: null })
  }, 10_000)
})
