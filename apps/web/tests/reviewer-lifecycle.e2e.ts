// Keyless shipped-Web coverage for the real Windows /review command, local
// subprocess, durable replay, presentation, Host recovery, and the POSIX
// composition that omits the unsupported command. Only the external Codex CLI
// is deterministic; Chromium, HTTP/RPC, command dispatch, persistence, and the
// shipped subprocess provider run as composed production code.
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { delimiter, join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'
import type {} from '@deepseek-ai/dsh-command-reviewer/types'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/reviewer-lifecycle', import.meta.url))
const COMPLETED_UI_EXPECTED = fileURLToPath(new URL('./snapshots/reviewer-lifecycle/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: durable reviewer lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let fakeCodexRoot: string
  let fakeCodexRelease: string
  let fakeCodexStarted: string
  let originalPath: string | undefined

  const seedConversationAndSubmitReview = async () => {
    const session = scaffold.ctx.sessions.list()[0]
    if (session === undefined) throw new Error('fresh workspace did not create a session')
    const agent = scaffold.ctx.agents.get(session.id)
    if (agent === undefined) throw new Error('fresh workspace did not create an agent')
    expect(scaffold.ctx.commands.list(agent).map(command => command.name)).toContain('review')
    expect(scaffold.ctx.settings.describe().map(descriptor => String(descriptor.ns))).toContain('command-reviewer')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please implement the concurrency fix.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    await input.fill('/review review the concurrency fix')
    await input.press('Enter')
    return { input, session }
  }

  beforeAll(async () => {
    fakeCodexRoot = await mkdtemp(join(tmpdir(), 'dsh-web-reviewer-codex-'))
    fakeCodexRelease = join(fakeCodexRoot, 'release')
    fakeCodexStarted = join(fakeCodexRoot, 'started')
    const fakeCodex = join(fakeCodexRoot, 'fake-codex.mjs')
    const reviewText = '## Review result\n\nThe browser request is detached from the admitted Codex process, and refresh replay preserves the result.'
    await writeFile(fakeCodex, [
      'const { existsSync, writeFileSync } = await import("node:fs")',
      `writeFileSync(${JSON.stringify(fakeCodexStarted)}, "")`,
      'await new Promise(resolve => { process.stdin.resume(); process.stdin.once("end", resolve) })',
      `const started = ${JSON.stringify([
        { type: 'thread.started', thread_id: 'web-reviewer-thread' },
        { type: 'turn.started' },
        { type: 'item.started', item: { id: 'reason', type: 'reasoning' } },
      ])}`,
      `const completed = ${JSON.stringify([
        { type: 'item.completed', item: { id: 'reason', type: 'reasoning' } },
        { type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'pnpm exec vitest run reviewer' } },
        { type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'Codex JSONL events' } },
        { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: reviewText } },
        { type: 'turn.completed' },
      ])}`,
      'for (const event of started) process.stdout.write(`${JSON.stringify(event)}\\n`)',
      `const release = ${JSON.stringify(fakeCodexRelease)}`,
      'while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20))',
      'for (const event of completed) process.stdout.write(`${JSON.stringify(event)}\\n`)',
      '',
    ].join('\n'))
    if (process.platform === 'win32') {
      await writeFile(join(fakeCodexRoot, 'codex.CMD'), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`)
    } else {
      const launcher = join(fakeCodexRoot, 'codex')
      await writeFile(launcher, '#!/usr/bin/env node\nimport "./fake-codex.mjs"\n')
      await chmod(launcher, 0o755)
    }
    originalPath = process.env.PATH
    process.env.PATH = `${fakeCodexRoot}${delimiter}${originalPath ?? ''}`
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      if (originalPath === undefined) Reflect.deleteProperty(process.env, 'PATH')
      else process.env.PATH = originalPath
      if (fakeCodexRoot !== undefined) await rm(fakeCodexRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'submits /review through Chromium and persists Windows Job-owned subprocess progress',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-reviewer-lifecycle'))
      const { input, session } = await seedConversationAndSubmitReview()

      await page.locator('[data-reviewer][data-review-status="running"]').waitFor({ timeout: 15_000 })
      await expect.poll(() => input.inputValue()).toBe('')
      try {
        await expect.poll(() => existsSync(fakeCodexStarted)).toBe(true)
        await expect.poll(() => session.events.some(event => event.type === 'review/activity')).toBe(true)
        const activity = page.getByLabel('Activity')
        await activity.getByText('analysis', { exact: true }).first().waitFor({ timeout: 15_000 })
        await activity.getByText('started', { exact: true }).first().waitFor({ timeout: 15_000 })
      } finally {
        await writeFile(fakeCodexRelease, '')
      }
      await page.locator('[data-reviewer][data-review-status="completed"]').waitFor({ timeout: 15_000 })
      expect(await input.isEnabled()).toBe(true)
      expect(await page.getByText('pnpm exec vitest run reviewer', { exact: true }).count()).toBe(1)
      expect(await page.getByText('Review result', { exact: true }).count()).toBe(1)
      expect(await page.locator('[data-command-input]').count()).toBe(0)
      expect(await page.locator('[data-command-id]').count()).toBe(0)
      await expect(scaffold.ctx.sessions.flush(session)).resolves.toBe(true)
      const persisted = await scaffold.ctx.sessionPersistence.inspect(session.id)
      expect(persisted.events.filter(event => event.type === 'command/run')).toMatchObject([{
        data: { name: 'review' },
      }])
      expect(persisted.events.find(event => event.type === 'command/run')?.data).not.toHaveProperty('args')
      expect(persisted.events.filter(event => event.type === 'review/start')).toHaveLength(1)
      expect(persisted.events.filter(event => event.type === 'review/activity').map(event => event.data))
        .toMatchObject([
          { activityId: 'turn', kind: 'analysis', status: 'started' },
          { activityId: 'reason', kind: 'analysis', status: 'started' },
          { activityId: 'reason', kind: 'analysis', status: 'completed' },
          { activityId: 'command', kind: 'command', status: 'completed' },
          { activityId: 'search', kind: 'web-search', status: 'completed' },
          { activityId: 'message', kind: 'message', status: 'completed' },
          { activityId: 'turn', kind: 'analysis', status: 'completed' },
        ])
      expect(persisted.events.filter(event => event.type === 'review/end')).toMatchObject([{
        data: { outcome: 'completed' },
      }])

      const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(COMPLETED_UI_EXPECTED, snapshot, MODE)
    },
    60_000,
  )

  it.skipIf(process.platform === 'win32')(
    'omits /review and its settings when the POSIX provider cannot own daemonized descendants',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-reviewer-posix-unsupported'))
      const session = scaffold.ctx.sessions.list()[0]
      if (session === undefined) throw new Error('fresh workspace did not create a session')
      const agent = scaffold.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('fresh workspace did not create an agent')
      expect(scaffold.ctx.commands.list(agent).map(command => command.name)).not.toContain('review')
      expect(scaffold.ctx.settings.describe().map(descriptor => String(descriptor.ns)))
        .not.toContain('command-reviewer')
      expect(existsSync(fakeCodexStarted)).toBe(false)

      await page.getByRole('button', { name: 'Commands' }).click()
      const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
      await menu.waitFor({ timeout: 10_000 })
      expect(await menu.getByRole('option', { name: /^review\b/i }).count()).toBe(0)
      await page.locator('textarea').first().press('Escape')
      expect(await page.locator('[data-reviewer]').count()).toBe(0)

      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
      await expect.poll(
        () => settings.getByRole('tab', { name: 'Plugin configuration', exact: true }).getAttribute('aria-selected'),
        { timeout: 5_000 },
      ).toBe('true')
      expect(await settings.getByText('Reviewer', { exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')

      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      expect(await page.locator('[data-reviewer]').count()).toBe(0)
      expect(scaffold.ctx.commands.list(agent).map(command => command.name)).not.toContain('review')
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
    },
    90_000,
  )

  it.skipIf(process.platform !== 'win32')(
    'restores the same terminal card after reload',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-reviewer-lifecycle-reload'))
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await page.locator('[data-reviewer][data-review-status="completed"]').waitFor({ timeout: 15_000 })
      expect(await page.getByText('Review result', { exact: true }).count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
    },
    90_000,
  )

  it.skipIf(process.platform !== 'win32')('closes a persisted open review when its Agent resumes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reviewer-interrupted-resume'))
    const sessionId = SessionId('reviewer-interrupted-web-e2e')
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')

    const original = await scaffold.ctx.agents.create({ sessionId, meta: { cwd } })
    const commandId = CommandId('review-interrupted-snapshot')
    original.agent.session.append('turn/start', { turn: 1 })
    const user = original.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Preserve this review across Host recovery.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    original.agent.session.append('session/title', {
      title: 'Interrupted reviewer recovery', messageSeqs: [user.seq], source: { kind: 'fallback' },
    })
    original.agent.session.append('turn/end', {
      turn: 1, reason: { kind: 'completed' },
    })
    original.agent.session.append('command/run', {
      commandId, name: 'review', source: { kind: 'user' },
    })
    const start = original.agent.session.append('review/start', {
      commandId,
      focus: 'check Host recovery',
      request: {
        prompt: 'Check Host recovery.',
        argv: ['/resolved/codex', 'exec', '--json'],
        cwd,
        hostDeath: 'terminate',
        timeoutMs: 1_800_000,
      },
    })
    await expect(scaffold.ctx.sessions.flush(original.agent.session)).resolves.toBe(true)
    await workspace.attachSession(sessionId)
    await original.dispose()
    expect(scaffold.ctx.agents.get(sessionId)).toBeUndefined()

    const resumed = await scaffold.ctx.agents.resume({ resumeSessionId: sessionId })
    try {
      const endings = resumed.agent.session.events.filter(event => (
        event.type === 'review/end' && event.data.commandId === commandId
      ))
      expect(endings).toEqual([expect.objectContaining({
        data: {
          commandId,
          outcome: 'interrupted',
          text: 'Review interrupted because its previous host stopped before recording completion.',
        },
      })])
      const commandDones = resumed.agent.session.events.filter(event => (
        event.type === 'command/done' && event.data.commandId === commandId
      ))
      expect(commandDones).toEqual([expect.objectContaining({
        data: { commandId, kind: 'success', sourceEventSeq: start.seq },
      })])
      await expect(scaffold.ctx.sessions.flush(resumed.agent.session)).resolves.toBe(true)
      const persisted = await scaffold.ctx.sessionPersistence.inspect(sessionId)
      expect(persisted.events.filter(event => (
        event.type === 'review/end' && event.data.commandId === commandId
      ))).toHaveLength(1)
      expect(persisted.events.filter(event => (
        event.type === 'command/done' && event.data.commandId === commandId
      ))).toHaveLength(1)

      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const row = page.getByRole('treeitem', { name: /Interrupted reviewer recovery/ })
      await row.waitFor({ timeout: 15_000 })
      await row.click()
      await page.locator('[data-reviewer][data-review-status="interrupted"]')
        .waitFor({ timeout: 15_000 })
      expect(await page.getByText(
        'Review interrupted because its previous host stopped before recording completion.',
        { exact: true },
      ).count()).toBe(1)
      expect(await page.locator(`[data-command-id="${commandId}"]`).count()).toBe(0)
    } finally {
      await resumed.dispose()
    }
  }, 120_000)
})
