// Keyless shipped-Web coverage for durable /review replay, presentation, and
// Host recovery. Synthetic records keep this lane independent of Codex and a
// model credential; real command/process evidence belongs to the live E2E run.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
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
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/reviewer-lifecycle/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: durable reviewer lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders real progress categories and the final review without a duplicate command row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reviewer-lifecycle'))
    const session = scaffold.ctx.sessions.list()[0]
    if (session === undefined) throw new Error('fresh workspace did not create a session')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please implement the concurrency fix.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const commandId = CommandId('review-snapshot')
    session.append('command/run', {
      commandId, name: 'review', args: ' review the concurrency fix', source: { kind: 'user' },
    })
    const start = session.append('review/start', {
      commandId,
      focus: 'review the concurrency fix',
      request: {
        prompt: 'Review the concurrency fix.',
        argv: ['/resolved/codex', 'exec', '--json'],
        cwd: scaffold.workspaceCwd,
        timeoutMs: 1_800_000,
      },
    })
    session.append('review/activity', {
      commandId, activityId: 'turn', kind: 'analysis', status: 'started',
    })
    session.append('review/activity', {
      commandId, activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm exec vitest run reviewer',
    })
    session.append('review/activity', {
      commandId, activityId: 'search', kind: 'web-search', status: 'completed', detail: 'Codex JSONL events',
    })
    session.append('review/activity', {
      commandId, activityId: 'message', kind: 'message', status: 'completed',
    })
    session.append('review/end', {
      commandId,
      outcome: 'completed',
      text: '## Review result\n\nThe browser request is detached from the admitted Codex process, and refresh replay preserves the result.',
    })
    session.append('command/done', { commandId, kind: 'success', sourceEventSeq: start.seq })

    await page.locator('[data-reviewer][data-review-status="completed"]').waitFor({ timeout: 15_000 })
    expect(await page.getByText('pnpm exec vitest run reviewer', { exact: true }).count()).toBe(1)
    expect(await page.getByText('Review result', { exact: true }).count()).toBe(1)
    expect(await page.locator('[data-command-input]').count()).toBe(0)
    expect(await page.locator('[data-command-id]').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('restores the same completed card after reload', async () => {
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
  }, 90_000)

  it('closes a persisted open review when its Agent resumes', async () => {
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
