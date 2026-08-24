// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-runtime/src/client/conversation/event-registry.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { ShadowMindSettingsTab } from '../src/client/ShadowMindSettingsTab.tsx'
import type { ShadowMindSettingsTabInjected } from '../src/client/ShadowMindSettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')

const SETTINGS = {
  heartbeatProbability: 0.3,
  maxParallelShadows: 2,
  defaultShadowTimeoutSeconds: 120,
  headlessDrainTimeoutSeconds: 180,
  resultBatchWindowMs: 100,
  argumentDisclosure: 'redacted' as const,
  maxPromptChars: 80_000,
  maxReportChars: 12_000,
  preferIndependentVendor: false,
  longOutputBoostChars: 50_000,
  lastReportCoversCount: 2,
  repeatedFailureBoostThreshold: 3,
  valueLoopEnabled: true,
  valueLoopWindowTurns: 2,
  reviewWindowSize: 8,
  spinningRepeatCount: 3,
  oscillationPeriods: 2,
  noDriftRepeatCount: 3,
  diminishingWindowSize: 5,
  diminishingNoveltyThreshold: 0.4,
  stagnationCooldownSeconds: 300,
  stagnationEscalationEnabled: false,
  reasoningEffortLadder: ['low', 'medium', 'high'],
  staleReportDecay: 0,
  conflictSynthesisEnabled: false,
  conflictSynthesisTimeoutSeconds: 60,
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  await ctx.plugin(ConversationEventRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const unmount = vi.fn(() => Promise.resolve())
  const emptyCatalog = { definitionRoot: 'C:/dsh/shadow-minds', definitions: [], diagnostics: [] }
  const shadowMind = {
    catalog: vi.fn(() => Promise.resolve({ ok: true as const, value: emptyCatalog })),
    create: vi.fn(),
    update: vi.fn(),
    setEnabled: vi.fn(),
    delete: vi.fn(),
    status: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: {
        paused: false,
        active: [],
        pendingSchedules: 0,
        epoch: 0,
        totalRuns: 0,
        prefilterSkips: 0,
        effectiveProbabilities: [],
        valueLoop: [],
        spentChars: 0,
        budgetTier: 'standard',
        cooldowns: [],
        pendingEscalations: [],
        recentReviews: [],
        synthesisRuns: 0,
        synthesisFailures: 0,
      },
    })),
    pause: vi.fn(),
    resume: vi.fn(),
    toggle: vi.fn(),
  }
  class ShadowMindRemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote.shadowMind')
      Object.assign(this, shadowMind)
    }
  }
  class RemoteService extends Service {
    readonly $mount = vi.fn(async () => {
      const fiber = this.ctx.plugin({
        name: 'remote.shadowMind',
        apply: (serviceCtx: Context) => { new ShadowMindRemoteService(serviceCtx) },
      })
      await fiber.await()
      return async () => {
        await unmount()
        await fiber.dispose()
      }
    })

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  const remote = new RemoteService(ctx)
  const settings = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: SETTINGS,
      base: SETTINGS,
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => () => {},
    set: vi.fn(() => Promise.resolve()),
    unset: vi.fn(() => Promise.resolve()),
  }
  ctx.provide('settingsScope', { bind: vi.fn(() => settings) })
  const notify = vi.fn()
  const conversation = { input: { for: vi.fn(() => ({ notify })) } }
  const sessionScope = { get: vi.fn(() => conversation) }
  const sessionId = 'blank-session' as SessionId
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current: sessionId }), subscribe: () => () => {} },
    scope: vi.fn(() => sessionScope),
    open: vi.fn(),
  })
  return { ctx, slots: ctx.slots, locale, remote, shadowMind, unmount, notify, sessionId }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      'conversation.chat.contextview': { kind: 'keyed', scope: 'session' },
      'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
}

afterEach(() => { vi.restoreAllMocks() })

describe('ui-shadow-mind browser plugin', () => {
  it('mounts its Remote, registers the Settings tab, and disposes both', async () => {
    expect(inject).toEqual([
      'slots', 'locale', 'sessions', 'remote', 'settingsScope', 'conversationEvents',
    ])
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(b.remote.$mount).toHaveBeenCalledOnce()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(ShadowMindSettingsTab)
    expect(entry.options).toMatchObject({ id: 'shadow-mind', order: 5 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('Shadow Mind')
    expect(b.slots.entries('conversation.chat.contextview')[0]?.options)
      .toMatchObject({ key: 'shadow-report' })
    expect(b.slots.entries('conversation.chat.turnTail')).toHaveLength(1)
    expect(b.ctx.conversationEvents.entries().map(definition => definition.kind))
      .toEqual(['shadow-mind-report'])
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()
    expect(injected.hooks.settings.getSnapshot().value).toEqual(SETTINGS)
    await expect(injected.catalog()).resolves.toEqual({
      definitionRoot: 'C:/dsh/shadow-minds', definitions: [], diagnostics: [],
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toEqual([])
    expect(b.slots.entries('conversation.chat.contextview')).toEqual([])
    expect(b.slots.entries('conversation.chat.turnTail')).toEqual([])
    expect(b.ctx.conversationEvents.entries()).toEqual([])
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })

  it('shows /shadow command results as a composer notice even for a blank session', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    b.ctx.emit('command/executed', b.sessionId, 'shadow', {
      kind: 'success', text: 'Shadow Mind active; 0 running; 0 pending schedules; 0 total runs; no completed runs.',
    })
    expect(b.notify).toHaveBeenCalledWith(
      'info', 'Shadow Mind active; 0 running; 0 pending schedules; 0 total runs; no completed runs.',
    )
    b.ctx.emit('command/executed', b.sessionId, 'shadow', { kind: 'error', text: 'Shadow failed.' })
    expect(b.notify).toHaveBeenCalledWith('error', 'Shadow failed.')
    b.ctx.emit('command/executed', b.sessionId, 'goal', { kind: 'success', text: 'ignored' })
    expect(b.notify).toHaveBeenCalledTimes(2)

    await fiber.dispose()
    b.ctx.emit('command/executed', b.sessionId, 'shadow', { kind: 'success', text: 'disposed' })
    expect(b.notify).toHaveBeenCalledTimes(2)
    await b.ctx.fiber.dispose()
  })

  it('reports Remote business failures through the Settings operations', async () => {
    const b = await bench()
    declare(b.slots)
    b.shadowMind.catalog.mockResolvedValueOnce({
      ok: false,
      error: { code: 'REMOTE_ERROR', message: 'unavailable' },
    } as never)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()
    await expect(injected.catalog()).rejects.toThrow(
      'shadowMind.catalog failed: REMOTE_ERROR: unavailable',
    )
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })
})
