// Keyless shipped-Web coverage for the durable /review lifecycle. Synthetic
// Session records isolate replay and presentation; the PR demo uses the real
// command, Codex process, and model flow.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
    const start = session.append('review/start', { commandId, focus: 'review the concurrency fix' })
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
})
