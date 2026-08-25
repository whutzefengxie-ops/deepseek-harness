// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ShadowAdministrationSnapshot,
  ShadowDefinition,
  ShadowDefinitionInput,
  ShadowMindSettings,
  ShadowMindStatus,
} from '@deepseek-ai/dsh-shadow-mind-runtime/types'
import {
  ShadowMindSettingsTab,
  type ShadowMindSettingsTabProps,
} from '../src/client/ShadowMindSettingsTab.tsx'
import { en, type ShadowMindLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SETTINGS: ShadowMindSettings = {
  heartbeatProbability: 0.3,
  maxParallelShadows: 2,
  defaultShadowTimeoutSeconds: 120,
  headlessDrainTimeoutSeconds: 180,
  resultBatchWindowMs: 100,
  argumentDisclosure: 'redacted',
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

const REVIEWER: ShadowDefinition = {
  id: 'reviewer',
  name: 'Independent reviewer',
  enabled: true,
  debug: false,
  activationProbability: 0.5,
  activeForModels: ['deepseek/*'],
  tools: [],
  capture: 'full',
  context: 'standard',
  thinkFirst: false,
  preFilters: [],
  boostFilters: [],
  boostFactor: 1,
  holdout: false,
  prompt: 'Review actionable risks.',
  sourcePath: 'C:/dsh/shadow-minds/reviewer.md',
}

const t = ((key: ShadowMindLocaleKey): string => en[key]) as ShadowMindSettingsTabProps['t']

/** Mirror the Runtime's nullable Web-input normalization in test adapters. */
function persisted(input: ShadowDefinitionInput): ShadowDefinition {
  return {
    id: input.id,
    name: input.name,
    enabled: input.enabled,
    debug: input.debug,
    activationProbability: input.activationProbability,
    activeForModels: input.activeForModels,
    ...(input.runWithModel === null ? {} : { runWithModel: input.runWithModel }),
    ...(input.reasoningEffort === null ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.timeoutSeconds === null ? {} : { timeoutSeconds: input.timeoutSeconds }),
    tools: input.tools,
    capture: input.capture,
    context: input.context,
    thinkFirst: input.thinkFirst,
    preFilters: input.preFilters,
    boostFilters: input.boostFilters,
    boostFactor: input.boostFactor,
    holdout: input.holdout,
    prompt: input.prompt,
    sourcePath: `C:/dsh/shadow-minds/${input.id}.md`,
  }
}

const STATUS: ShadowMindStatus = {
  paused: false,
  active: [],
  pendingSchedules: 0,
  epoch: 0,
  totalRuns: 3,
  prefilterSkips: 1,
  effectiveProbabilities: [{ shadowId: 'reviewer', probability: 0.5 }],
  valueLoop: [{ shadowId: 'reviewer', challenges: 1, adopted: 1, rejected: 0, ignored: 0, hitRate: 1 }],
  spentChars: 320,
  budgetTier: 'standard',
  cooldowns: [],
  pendingEscalations: [],
  recentReviews: [{
    shadowId: 'reviewer', runId: 'run-1', verdict: 'challenge', refs: [4],
    capturedThroughSeq: 41, finishedAt: '2026-08-23T10:00:00.000Z',
  }],
  synthesisRuns: 1,
  synthesisFailures: 0,
  lastRun: {
    shadowId: 'reviewer',
    childSessionId: 'shadow-child' as SessionId,
    capturedThroughSeq: 41,
    finishedAt: '2026-08-23T10:00:00.000Z',
    outcome: 'report',
    deliberationChars: 120,
    independence: 'independent',
    route: 'mock/reviewer',
  },
}

function props(overrides: Partial<ShadowMindSettingsTabProps> = {}): ShadowMindSettingsTabProps {
  const snapshot = {
    status: 'ready' as const,
    value: SETTINGS,
    base: SETTINGS,
    user: {},
    revision: 0,
    writable: true,
    mode: 'host' as const,
  }
  const sessionId = 'root-session' as SessionId
  const componentProps = {
    t,
    useSettings: (selector: (value: typeof snapshot) => unknown) => selector(snapshot),
    useSessions: (selector: (value: {
      current: SessionId
      byId: Record<SessionId, { updatedAt: number }>
    }) => unknown) => selector({ current: sessionId, byId: { [sessionId]: { updatedAt: 1 } } }),
    saveSettings: vi.fn(() => Promise.resolve()),
    catalog: () => Promise.resolve({
      definitionRoot: 'C:/dsh/shadow-minds',
      definitions: [REVIEWER],
      diagnostics: [],
    }),
    create: (input: ShadowDefinitionInput) => Promise.resolve(persisted(input)),
    update: (input: ShadowDefinitionInput) => Promise.resolve(persisted(input)),
    setEnabled: (id: string, enabled: boolean) => Promise.resolve({ ...REVIEWER, id, enabled }),
    delete: () => Promise.resolve(),
    status: () => Promise.resolve(STATUS),
    pause: () => Promise.resolve({ ...STATUS, paused: true, epoch: 1 }),
    resume: () => Promise.resolve({ ...STATUS, paused: false, epoch: 1 }),
    toggle: () => Promise.resolve({ ...STATUS, paused: true, epoch: 1 }),
  }
  return { ...componentProps, ...overrides } as unknown as ShadowMindSettingsTabProps
}

describe('ShadowMindSettingsTab', () => {
  it('shows root status, all scheduling settings, definitions, and diagnostics', async () => {
    const view = render(<ShadowMindSettingsTab {...props()} />)

    expect(await screen.findByText(en.sessionActive)).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.settingsTitle })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.definitionsTitle })).toBeTruthy()
    expect(screen.getByText('Independent reviewer')).toBeTruthy()
    expect(screen.getByText('C:/dsh/shadow-minds/reviewer.md')).toBeTruthy()
    expect(screen.getByText(en.noDiagnostics)).toBeTruthy()
    expect(screen.getByText(en.outcomeReport)).toBeTruthy()
    expect(screen.getByText('shadow-child')).toBeTruthy()
    expect(view.container.querySelectorAll('[id^="shadow-setting-"]')).toHaveLength(32)
  })

  it('saves settings and controls the current root session', async () => {
    const save = vi.fn<(next: ShadowMindSettings) => Promise<void>>(() => Promise.resolve())
    const pause = vi.fn(() => Promise.resolve({
      ...STATUS, paused: true, epoch: 1,
    }))
    const view = render(<ShadowMindSettingsTab {...props({
      saveSettings: save,
      pause,
    })} />)
    await screen.findByText(en.sessionActive)

    const heartbeat = view.container.querySelector<HTMLInputElement>('#shadow-setting-heartbeatProbability')!
    fireEvent.change(heartbeat, { target: { value: '0.75' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveSettings }))
    await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
    expect(save.mock.calls[0]?.[0]).toMatchObject({ heartbeatProbability: 0.75 })

    fireEvent.click(screen.getByRole('button', { name: en.pause }))
    await waitFor(() => { expect(pause).toHaveBeenCalledWith('root-session') })
    expect(await screen.findByText(en.sessionPaused)).toBeTruthy()
  })

  it('edits every structured setting, discards it, and exposes pending save state', async () => {
    let finishSave!: () => void
    let settingsReady = true
    const save = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve }))
    const editableProps = props({
      saveSettings: save,
      useSettings: (selector: (value: unknown) => unknown) => selector(settingsReady
        ? {
          status: 'ready', value: SETTINGS, base: SETTINGS, user: {}, revision: 0,
          writable: true, mode: 'host',
        }
        : {
          status: 'loading', value: undefined, base: undefined, user: {}, revision: 1,
          writable: false, mode: 'host',
        }),
    } as never)
    const view = render(<ShadowMindSettingsTab {...editableProps} />)
    await screen.findByText(en.sessionActive)

    fireEvent.change(view.container.querySelector('#shadow-setting-argumentDisclosure')!, {
      target: { value: 'full' },
    })
    fireEvent.change(view.container.querySelector('#shadow-setting-reasoningEffortLadder')!, {
      target: { value: 'low\nhigh' },
    })
    for (const field of [
      'preferIndependentVendor',
      'valueLoopEnabled',
      'stagnationEscalationEnabled',
      'conflictSynthesisEnabled',
    ]) {
      fireEvent.change(view.container.querySelector(`#shadow-setting-${field}`)!, {
        target: { value: field === 'valueLoopEnabled' ? 'false' : 'true' },
      })
    }
    for (const [field, value] of [
      ['sessionShadowSoftBudgetChars', '10000'],
      ['sessionShadowHardBudgetChars', '20000'],
      ['frugalShadowModel', 'deepseek/deepseek-chat'],
    ]) {
      fireEvent.change(view.container.querySelector(`#shadow-setting-${field}`)!, { target: { value } })
    }

    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect((view.container.querySelector('#shadow-setting-argumentDisclosure') as HTMLSelectElement).value)
      .toBe('redacted')

    fireEvent.change(view.container.querySelector('#shadow-setting-heartbeatProbability')!, {
      target: { value: '0.75' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.saveSettings }))
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: en.saving })).disabled).toBe(true)
    await act(async () => { finishSave() })
    expect(await screen.findByText(en.saved)).toBeTruthy()

    settingsReady = false
    view.rerender(<ShadowMindSettingsTab {...editableProps} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.discard }).disabled).toBe(true)
  })

  it('shows disconnected and refresh failures without issuing a status request', async () => {
    const catalog = vi.fn(() => Promise.reject(new Error('catalog offline')))
    const status = vi.fn(() => Promise.resolve(STATUS))
    const disconnected = props({
      catalog,
      status,
      useSettings: (selector: (value: unknown) => unknown) => selector({
        status: 'loading', value: undefined, base: undefined, user: {}, revision: 0,
        writable: false, mode: 'host',
      }),
      useSessions: (selector: (value: unknown) => unknown) => selector({ current: undefined, byId: {} }),
    } as never)
    const view = render(<ShadowMindSettingsTab {...disconnected} />)

    expect((await screen.findByRole('alert')).textContent).toContain(en.loadError)
    expect(screen.getByText(en.noSession)).toBeTruthy()
    expect(screen.getAllByText(en.loadError)).toHaveLength(2)
    expect(status).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(catalog).toHaveBeenCalledTimes(2) })
    view.unmount()
  })

  it('contains status failures and ignores settled requests after unmount', async () => {
    const refreshStatus = vi.fn()
      .mockResolvedValueOnce(STATUS)
      .mockRejectedValueOnce(new Error('status offline'))
    const view = render(<ShadowMindSettingsTab {...props({ status: refreshStatus })} />)
    await screen.findByText(en.sessionActive)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.loadError)
    view.unmount()

    let resolveStatus!: (value: ShadowMindStatus) => void
    const pendingSuccess = new Promise<ShadowMindStatus>((resolve) => { resolveStatus = resolve })
    const successView = render(<ShadowMindSettingsTab {...props({ status: () => pendingSuccess })} />)
    successView.unmount()
    await act(async () => { resolveStatus(STATUS) })

    let rejectStatus!: (error: Error) => void
    const pendingFailure = new Promise<ShadowMindStatus>((_resolve, reject) => { rejectStatus = reject })
    const failureView = render(<ShadowMindSettingsTab {...props({ status: () => pendingFailure })} />)
    failureView.unmount()
    await act(async () => { rejectStatus(new Error('late failure')) })
  })

  it('shows a status load failure while the current Session remains selected', async () => {
    render(<ShadowMindSettingsTab {...props({
      status: () => Promise.reject(new Error('status unavailable')),
    })} />)

    expect((await screen.findByRole('alert')).textContent).toContain(en.loadError)
    expect(screen.getByText(en.noSession)).toBeTruthy()
  })

  it('renders sparse telemetry and reports Error and non-Error operation failures', async () => {
    const { lastRun: _lastRun, ...statusWithoutLastRun } = STATUS
    const sparse = {
      ...statusWithoutLastRun,
      paused: true,
      effectiveProbabilities: [],
      valueLoop: [],
      cooldowns: [{
        shadowId: 'reviewer',
        until: '2026-08-23T11:00:00.000Z',
        patterns: ['spinning'],
      }],
      pendingEscalations: ['reviewer'],
      recentReviews: [],
      lastSynthesisFailure: 'conflicting reports',
    } satisfies ShadowMindStatus
    const { route: _route, childSessionId: _childSessionId, ...lastRunWithoutRoute } = STATUS.lastRun!
    const completed = {
      ...STATUS,
      lastRun: {
        ...lastRunWithoutRoute,
        outcome: 'silent' as const,
      },
    }
    const resume = vi.fn(() => Promise.resolve(completed))
    const pause = vi.fn(() => Promise.reject(new Error('pause failed')))
    const toggle = vi.fn(() => Promise.reject(new Error('toggle failed')))
    const catalog = () => Promise.resolve({
      definitionRoot: 'C:/dsh/shadow-minds',
      definitions: [],
      diagnostics: [{ path: 'broken.md', error: 'invalid frontmatter' }],
    })
    render(<ShadowMindSettingsTab {...props({
      status: () => Promise.resolve(sparse), resume, pause, toggle, catalog,
    })} />)

    expect(await screen.findByText(en.sessionPaused)).toBeTruthy()
    expect(screen.getByText(en.noCompletedRuns)).toBeTruthy()
    expect(screen.getByText('conflicting reports')).toBeTruthy()
    expect(screen.getByText(en.emptyDefinitions)).toBeTruthy()
    expect(screen.getByText('broken.md')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.resume }))
    expect(await screen.findByText(en.outcomeSilent)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.pause }))
    expect((await screen.findByRole('status')).textContent).toContain(`${en.operationFailed}: pause failed`)
    fireEvent.click(screen.getByRole('button', { name: en.toggle }))
    expect((await screen.findByRole('status')).textContent).toContain(`${en.operationFailed}: toggle failed`)
  })

  it('shows a component failure instead of leaving the Settings tab blank', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ShadowMindSettingsTab {...props({
      useSettings: () => { throw new Error('settings snapshot failed') },
    })} />)

    expect(screen.getByRole('alert').textContent).toContain(en.renderErrorTitle)
    expect(screen.getByRole('alert').textContent).toContain('settings snapshot failed')
  })

  it('normalizes a non-Error component failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ShadowMindSettingsTab {...props({
      useSettings: () => { throw 'string failure' },
    })} />)

    expect(screen.getByRole('alert').textContent).toContain('string failure')
  })

  it('creates, edits, enables, and deletes complete Shadow definitions', async () => {
    let definitions: ShadowDefinition[] = [REVIEWER]
    const catalog = vi.fn((): Promise<ShadowAdministrationSnapshot> => Promise.resolve({
      definitionRoot: 'C:/dsh/shadow-minds',
      definitions,
      diagnostics: [],
    }))
    const create = vi.fn(async (input: ShadowDefinitionInput) => {
      const created = persisted(input)
      definitions = [...definitions, created]
      return created
    })
    const update = vi.fn(async (input: ShadowDefinitionInput) => {
      const updated = persisted(input)
      definitions = definitions.map(value => value.id === input.id ? updated : value)
      return updated
    })
    const setEnabled = vi.fn(async (id: string, enabled: boolean) => {
      definitions = definitions.map(value => value.id === id ? { ...value, enabled } : value)
      return definitions.find(value => value.id === id)!
    })
    const remove = vi.fn(async (id: string) => {
      definitions = definitions.filter(value => value.id !== id)
    })
    render(<ShadowMindSettingsTab {...props({ catalog, create, update, setEnabled, delete: remove })} />)
    await screen.findByText('Independent reviewer')

    fireEvent.click(screen.getByRole('button', { name: en.disable }))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledWith('reviewer', false) })
    expect(await screen.findByText(en.disabled)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(document.querySelector<HTMLInputElement>('#shadow-definition-name')!, {
      target: { value: 'Security reviewer' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.saveDefinition }))
    await waitFor(() => { expect(update).toHaveBeenCalledOnce() })
    expect(await screen.findByText('Security reviewer')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.addShadow }))
    for (const [id, value] of [
      ['shadow-definition-id', 'architecture'],
      ['shadow-definition-name', 'Architecture reviewer'],
      ['shadow-definition-probability', '0.8'],
      ['shadow-definition-models', 'deepseek/*\nopenai/*'],
      ['shadow-definition-run-model', 'deepseek/deepseek-reasoner'],
      ['shadow-definition-effort', 'high'],
      ['shadow-definition-timeout', '90'],
      ['shadow-definition-tools', 'read\nsearch'],
      ['shadow-definition-prefilters', 'long-output'],
      ['shadow-definition-boostfilters', 'repeated-failure'],
      ['shadow-definition-boostfactor', '2'],
      ['shadow-definition-prompt', 'Review architecture risks.'],
    ]) {
      fireEvent.change(document.querySelector(`#${id}`)!, { target: { value } })
    }
    fireEvent.change(document.querySelector('#shadow-definition-capture')!, {
      target: { value: 'since-compaction' },
    })
    fireEvent.change(document.querySelector('#shadow-definition-context')!, {
      target: { value: 'minimal' },
    })
    for (const checkbox of document.querySelectorAll<HTMLInputElement>('[data-shadow-editor] input[type="checkbox"]')) {
      fireEvent.click(checkbox)
    }
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(create).toHaveBeenCalledOnce() })
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      id: 'architecture',
      enabled: false,
      debug: true,
      activeForModels: ['deepseek/*', 'openai/*'],
      runWithModel: 'deepseek/deepseek-reasoner',
      reasoningEffort: 'high',
      timeoutSeconds: 90,
      tools: ['read', 'search'],
      capture: 'since-compaction',
      context: 'minimal',
      thinkFirst: true,
      preFilters: ['long-output'],
      boostFilters: ['repeated-failure'],
      boostFactor: 2,
      holdout: true,
    })
    expect(await screen.findByText('Architecture reviewer')).toBeTruthy()

    const architecture = screen.getByText('Architecture reviewer').closest('li')!
    fireEvent.click(architecture.querySelector<HTMLButtonElement>('button[data-confirm="false"]')!)
    fireEvent.click(architecture.querySelector<HTMLButtonElement>('button[data-confirm="true"]')!)
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('architecture') })
    await waitFor(() => { expect(screen.queryByText('Architecture reviewer')).toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: en.addShadow }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(document.querySelector('[data-shadow-editor]')).toBeNull()
  })
})
