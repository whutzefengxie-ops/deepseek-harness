// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-runtime/src/client/conversation/event-registry.ts'
import type { SessionId, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShadowMindSettings } from '@deepseek-ai/dsh-shadow-mind-runtime/types'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { ShadowMindSettingsTab } from '../src/client/ShadowMindSettingsTab.tsx'
import type { ShadowMindSettingsTabInjected } from '../src/client/ShadowMindSettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')

const SETTINGS: ShadowMindSettings = {
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
  const mutate = vi.fn(() => Promise.resolve({
    result: {
      ok: true as const,
      value: {
        ns: 'shadow-mind',
        schema: {},
        value: SETTINGS,
        base: SETTINGS,
        user: {},
        applies: 'live' as const,
        secrets: [],
        revision: 1,
      },
    },
  }))
  ctx.provide('connection', { api: { settings: { mutate } } } as never)
  const settings = {
    getSnapshot: vi.fn<() => SettingsScopeSnapshot<ShadowMindSettings>>(() => ({
      status: 'ready' as const,
      value: SETTINGS,
      base: SETTINGS,
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    })),
    subscribe: () => () => {},
    set: vi.fn<(field: string, value: unknown) => Promise<void>>(() => Promise.resolve()),
    unset: vi.fn<(field: string) => Promise<void>>(() => Promise.resolve()),
  }
  ctx.provide('settingsScope', { bind: vi.fn(() => settings) })
  const notify = vi.fn()
  const conversation = { input: { for: vi.fn(() => ({ notify })) } }
  const sessionScope = { get: vi.fn(() => conversation) }
  const sessionId = 'blank-session' as SessionId
  const sessions = {
    list: { getSnapshot: () => ({ current: sessionId }), subscribe: () => () => {} },
    scope: vi.fn(() => sessionScope),
    open: vi.fn(),
  }
  ctx.provide('sessions', sessions)
  return { ctx, slots: ctx.slots, locale, mutate, remote, sessions, settings, shadowMind, unmount, notify, sessionId }
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
      'connection', 'slots', 'locale', 'sessions', 'remote', 'settingsScope', 'conversationEvents',
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
    const reportInjected = (b.slots.entries('conversation.chat.contextview')[0]!.inject as
      unknown as () => { openSession: (sessionId: SessionId) => void })()
    reportInjected.openSession('shadow-child' as SessionId)
    expect(b.sessions.open).toHaveBeenCalledWith('shadow-child')
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
    b.ctx.emit('command/executed', b.sessionId, 'shadow', { kind: 'success' } as never)
    expect(b.notify).toHaveBeenCalledTimes(2)

    b.sessions.scope.mockReturnValueOnce(undefined as never)
    b.ctx.emit('command/executed', b.sessionId, 'shadow', { kind: 'success', text: 'missing scope' })
    const get = vi.fn(() => undefined)
    b.sessions.scope.mockReturnValueOnce({ get } as never)
    b.ctx.emit('command/executed', b.sessionId, 'shadow', { kind: 'success', text: 'missing conversation' })
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

  it('forwards every Settings administration operation to its Remote method', async () => {
    const b = await bench()
    declare(b.slots)
    const definition = { id: 'reviewer' }
    const initialStatus = await b.shadowMind.status()
    if (!initialStatus.ok) throw new Error('status fixture failed')
    const status = initialStatus.value
    for (const method of ['create', 'update', 'setEnabled'] as const) {
      b.shadowMind[method].mockResolvedValue({ ok: true, value: definition })
    }
    b.shadowMind.delete.mockResolvedValue({ ok: true, value: undefined })
    for (const method of ['status', 'pause', 'resume', 'toggle'] as const) {
      b.shadowMind[method].mockResolvedValue({ ok: true, value: status })
    }
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()
    const input = { id: 'reviewer' }

    await expect(injected.create(input as never)).resolves.toBe(definition)
    await expect(injected.update(input as never)).resolves.toBe(definition)
    await expect(injected.setEnabled('reviewer', false)).resolves.toBe(definition)
    await expect(injected.delete('reviewer')).resolves.toBeUndefined()
    await expect(injected.status(b.sessionId)).resolves.toBe(status)
    await expect(injected.pause(b.sessionId)).resolves.toBe(status)
    await expect(injected.resume(b.sessionId)).resolves.toBe(status)
    await expect(injected.toggle(b.sessionId)).resolves.toBe(status)
    expect(b.shadowMind.setEnabled).toHaveBeenCalledWith('reviewer', false)
    expect(b.shadowMind.delete).toHaveBeenCalledWith('reviewer')

    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it.each([
    { status: 'ready', value: SETTINGS, writable: false },
    { status: 'loading', value: SETTINGS, writable: true },
    { status: 'ready', value: undefined, writable: true },
  ])('rejects a non-writable settings snapshot %#', async (snapshot) => {
    const b = await bench()
    declare(b.slots)
    b.settings.getSnapshot.mockReturnValue({
      ...snapshot,
      base: SETTINGS,
      user: {},
      revision: 1,
      mode: 'host',
    } as never)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()

    await expect(injected.saveSettings(SETTINGS)).rejects.toThrow('Shadow Mind settings are not writable')

    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('persists review-quality settings and clears removed optional overrides', async () => {
    const b = await bench()
    declare(b.slots)
    b.settings.getSnapshot.mockReturnValue({
      status: 'ready',
      value: {
        ...SETTINGS,
        sessionShadowSoftBudgetChars: 10_000,
        sessionShadowHardBudgetChars: 20_000,
        frugalShadowModel: 'deepseek/deepseek-chat',
      },
      base: SETTINGS,
      user: {
        sessionShadowSoftBudgetChars: 10_000,
        sessionShadowHardBudgetChars: 20_000,
        frugalShadowModel: 'deepseek/deepseek-chat',
      },
      revision: 1,
      writable: true,
      mode: 'host',
    })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()

    await injected.saveSettings({
      ...SETTINGS,
      longOutputBoostChars: 60_000,
      reasoningEffortLadder: ['low', 'high'],
      conflictSynthesisEnabled: true,
    })

    expect(b.mutate).toHaveBeenCalledWith({
      ns: 'shadow-mind',
      expectedRevision: 1,
      ops: [
        { op: 'set', path: ['longOutputBoostChars'], value: 60_000 },
        { op: 'set', path: ['reasoningEffortLadder'], value: ['low', 'high'] },
        { op: 'set', path: ['conflictSynthesisEnabled'], value: true },
        { op: 'unset', path: ['sessionShadowSoftBudgetChars'] },
        { op: 'unset', path: ['sessionShadowHardBudgetChars'] },
        { op: 'unset', path: ['frugalShadowModel'] },
      ],
    })

    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('saves mutually dependent budget settings in one revision-fenced mutation', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()

    await injected.saveSettings({
      ...SETTINGS,
      sessionShadowSoftBudgetChars: 10_000,
      sessionShadowHardBudgetChars: 20_000,
      frugalShadowModel: 'deepseek/deepseek-chat',
    })

    expect(b.mutate).toHaveBeenCalledWith({
      ns: 'shadow-mind',
      expectedRevision: 0,
      ops: [
        { op: 'set', path: ['sessionShadowSoftBudgetChars'], value: 10_000 },
        { op: 'set', path: ['sessionShadowHardBudgetChars'], value: 20_000 },
        { op: 'set', path: ['frugalShadowModel'], value: 'deepseek/deepseek-chat' },
      ],
    })

    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('omits an unavailable revision and reports a rejected atomic mutation', async () => {
    const b = await bench()
    declare(b.slots)
    b.settings.getSnapshot.mockReturnValue({
      status: 'ready',
      value: SETTINGS,
      base: SETTINGS,
      user: {},
      revision: undefined,
      writable: true,
      mode: 'host',
    })
    b.mutate.mockResolvedValueOnce({
      result: {
        ok: false,
        error: { code: 'settings-rejected', message: 'budget fields must be configured together' },
      },
    } as never)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()

    await expect(injected.saveSettings({ ...SETTINGS, longOutputBoostChars: 60_000 }))
      .rejects.toThrow(
        'Shadow Mind settings save failed: settings-rejected: budget fields must be configured together',
      )
    expect(b.mutate).toHaveBeenCalledWith({
      ns: 'shadow-mind',
      ops: [{ op: 'set', path: ['longOutputBoostChars'], value: 60_000 }],
    })

    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('skips an atomic mutation when the resolved form is unchanged', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => ShadowMindSettingsTabInjected)()

    await injected.saveSettings(SETTINGS)

    expect(b.mutate).not.toHaveBeenCalled()
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })
})
