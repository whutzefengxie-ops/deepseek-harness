// Process-level recovery proof for the Windows-only reviewer lifecycle. The
// browser, built Host, persisted Session, fake external Codex, and Job-owned
// descendant all cross the same force-killed Host boundary.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, vi } from 'vitest'
import {
  REPO_ROOT, connectFreshWorkspace, newEnglishPage, probeFreePort, requireDist, saveFailureShot,
} from './support.ts'

interface ManagedTree {
  root: number
  descendant: number
}

interface HistoryPage {
  events: Array<{ event: { seq: number; type: string; data: unknown } }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
    }
    const resolveOnce = (url: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveReady(url)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (match?.[1] !== undefined) resolveOnce(match[1])
    }
    const onExit = (code: number | null): void => {
      rejectOnce(new Error(`dsh web exited before readiness (code ${String(code)}):\n${output}`))
    }
    const timer = setTimeout(() => {
      rejectOnce(new Error(`dsh web did not become ready:\n${output}`))
    }, 90_000)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolveExit => child.once('close', () => { resolveExit() }))
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: `reviewer-host-recovery-${method}`, method, payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

async function readManagedTree(path: string): Promise<ManagedTree> {
  return await vi.waitFor(async () => {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ManagedTree>
    if (!Number.isSafeInteger(value.root) || !Number.isSafeInteger(value.descendant)
      || (value.root ?? 0) <= 0 || (value.descendant ?? 0) <= 0 || value.root === value.descendant) {
      throw new Error(`invalid fake Codex process tree: ${JSON.stringify(value)}`)
    }
    return value as ManagedTree
  }, { interval: 20, timeout: 15_000 })
}

async function waitForTreeGone(tree: ManagedTree): Promise<void> {
  await Promise.all([tree.root, tree.descendant].map(async (pid) => {
    await vi.waitFor(() => {
      if (processExists(pid)) throw new Error(`reviewer process ${String(pid)} remains alive`)
    }, { interval: 25, timeout: 15_000 })
  }))
}

function eventsFor(history: HistoryPage, commandId: string, type: string): Array<{ type: string; data: unknown }> {
  return history.events.map(item => item.event).filter(event => (
    event.type === type && isRecord(event.data) && event.data.commandId === commandId
  ))
}

it.skipIf(process.platform !== 'win32')(
  'force-kills an admitted reviewer tree and recovers its persisted lifecycle exactly once',
  async () => {
    requireDist()
    const world = await mkdtemp(join(tmpdir(), 'dsh-reviewer-host-recovery-'))
    const home = join(world, '.dsh')
    const agentsHome = join(world, '.agents')
    const workspaceRoot = join(world, 'workspace-root')
    const fakeCodexRoot = join(world, 'fake-codex')
    const treePath = join(fakeCodexRoot, 'tree.json')
    const binPath = join(REPO_ROOT, 'apps/cli/lib/bin.js')
    const overlay = join(world, 'reviewer-host-recovery.overlay.yml')
    const port = await probeFreePort()
    const baseUrl = `http://127.0.0.1:${String(port)}`
    let host: ChildProcess | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    let tree: ManagedTree | undefined
    const cleanupFailures: unknown[] = []

    const launchHost = async (): Promise<void> => {
      host = spawn(process.execPath, [
        binPath, 'web', '--patch', overlay, '--no-open', '--port', String(port),
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-reviewer-host-recovery-no-call',
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
          DSH_HOME: home,
          DSH_AGENTS_HOME: agentsHome,
          PATH: `${fakeCodexRoot}${delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(await waitForReadyLine(host)).toBe(baseUrl)
    }

    try {
      await mkdir(fakeCodexRoot, { recursive: true })
      await mkdir(home, { recursive: true })
      await mkdir(workspaceRoot, { recursive: true })
      await writeFile(join(home, 'settings.yaml'), [
        'ui-onboarding:',
        '  welcomeNoticeVersion: 2026-08-13.1',
        '',
      ].join('\n'))
      await writeFile(overlay, [
        '- id: directory-picker',
        '  disabled: true',
        '- id: llm-retry',
        '  disabled: true',
        '- id: session-title-llm',
        '  disabled: true',
        '- insert:',
        '    - id: directory-picker-browse',
        "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
        '    - id: ui-directory-picker-browse',
        "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
        '',
      ].join('\n'))
      await writeFile(join(fakeCodexRoot, 'fake-codex.mjs'), [
        'import { spawn } from "node:child_process"',
        'import { writeFileSync } from "node:fs"',
        'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" })',
        `writeFileSync(${JSON.stringify(treePath)}, JSON.stringify({ root: process.pid, descendant: descendant.pid }))`,
        'descendant.unref()',
        'process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\\n`)',
        'setInterval(() => {}, 60000)',
        '',
      ].join('\n'))
      await writeFile(
        join(fakeCodexRoot, 'codex.CMD'),
        `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`,
      )

      await launchHost()
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'reviewer-host-recovery') })
      await page.goto(baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, workspaceRoot)
      const input = page.locator('textarea').first()
      await input.fill('Preserve this message as reviewer recovery evidence.')
      await input.press('Enter')
      const sessions = await vi.waitFor(async () => {
        const listed = await rpc<{ items: Array<{ sessionId: string }> }>(baseUrl, 'session.list', {})
        if (listed.items.length !== 1) throw new Error('reviewer session was not listed')
        return listed
      }, { interval: 50, timeout: 15_000 })
      const sessionId = sessions.items[0]?.sessionId
      if (sessionId === undefined) throw new Error('reviewer session was not listed')
      await vi.waitFor(async () => {
        const history = await rpc<HistoryPage>(baseUrl, 'session.history', { sessionId, maxMessages: 100 })
        if (!history.events.some(item => item.event.type === 'user/message')) {
          throw new Error('seed user message is not durable yet')
        }
      }, { interval: 50, timeout: 15_000 })
      await page.locator('textarea:enabled').first().waitFor({ timeout: 15_000 })
      await input.fill('/review verify external Host recovery')
      const admittedResponse = page.waitForResponse(response => response.url() === `${baseUrl}/api/commands/execute`)
      await input.press('Enter')
      expect((await admittedResponse).status()).toBe(200)
      await page.locator('[data-reviewer][data-review-status="running"]').waitFor({ timeout: 15_000 })
      tree = await readManagedTree(treePath)

      const before = await rpc<HistoryPage>(baseUrl, 'session.history', { sessionId, maxMessages: 100 })
      const start = before.events.map(item => item.event).find(event => event.type === 'review/start')
      if (!isRecord(start?.data) || typeof start.data.commandId !== 'string') {
        throw new Error('persisted reviewer start was not readable before Host termination')
      }
      const commandId = start.data.commandId

      const firstHost = host
      if (firstHost === undefined || !firstHost.kill('SIGKILL')) throw new Error('failed to force-kill reviewer Host')
      await waitForExit(firstHost)
      host = undefined
      await waitForTreeGone(tree)

      await launchHost()
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await page.locator('[data-reviewer][data-review-status="interrupted"]').waitFor({ timeout: 30_000 })
      expect(await page.getByText(
        'Review interrupted because its previous host stopped before recording completion.',
        { exact: true },
      ).count()).toBe(1)

      const recovered = await rpc<HistoryPage>(baseUrl, 'session.history', { sessionId, maxMessages: 100 })
      expect(eventsFor(recovered, commandId, 'review/start')).toHaveLength(1)
      expect(eventsFor(recovered, commandId, 'review/end')).toMatchObject([{
        data: { outcome: 'interrupted' },
      }])
      expect(eventsFor(recovered, commandId, 'command/done')).toMatchObject([{
        data: { kind: 'success', sourceEventSeq: start.seq },
      }])

      await page.reload({ waitUntil: 'load' })
      await page.locator('[data-reviewer][data-review-status="interrupted"]').waitFor({ timeout: 30_000 })
      const reloaded = await rpc<HistoryPage>(baseUrl, 'session.history', { sessionId, maxMessages: 100 })
      expect(eventsFor(reloaded, commandId, 'review/end')).toHaveLength(1)
      expect(eventsFor(reloaded, commandId, 'command/done')).toHaveLength(1)
    } finally {
      await browser?.close().catch((error: unknown) => cleanupFailures.push(error))
      if (host !== undefined && host.exitCode === null && host.signalCode === null) {
        host.kill('SIGKILL')
        await waitForExit(host).catch((error: unknown) => cleanupFailures.push(error))
      }
      if (tree !== undefined) {
        for (const pid of [tree.descendant, tree.root]) {
          if (!processExists(pid)) continue
          try { process.kill(pid, 'SIGKILL') } catch { /* The Job or peer cleanup already removed this exact pid. */ }
        }
      }
      await rm(world, { recursive: true, force: true }).catch((error: unknown) => cleanupFailures.push(error))
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'reviewer Host-recovery cleanup failed')
    }
  },
  180_000,
)
