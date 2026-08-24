// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

afterEach(cleanup)

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

  it('shows a component failure instead of leaving the Settings tab blank', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ShadowMindSettingsTab {...props({
      useSettings: () => { throw new Error('settings snapshot failed') },
    })} />)

    expect(screen.getByRole('alert').textContent).toContain(en.renderErrorTitle)
    expect(screen.getByRole('alert').textContent).toContain('settings snapshot failed')
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
    fireEvent.change(document.querySelector<HTMLInputElement>('#shadow-definition-id')!, {
      target: { value: 'architecture' },
    })
    fireEvent.change(document.querySelector<HTMLInputElement>('#shadow-definition-name')!, {
      target: { value: 'Architecture reviewer' },
    })
    fireEvent.change(document.querySelector<HTMLTextAreaElement>('#shadow-definition-prompt')!, {
      target: { value: 'Review architecture risks.' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(create).toHaveBeenCalledOnce() })
    expect(await screen.findByText('Architecture reviewer')).toBeTruthy()

    const architecture = screen.getByText('Architecture reviewer').closest('li')!
    fireEvent.click(architecture.querySelector<HTMLButtonElement>('button[data-confirm="false"]')!)
    fireEvent.click(architecture.querySelector<HTMLButtonElement>('button[data-confirm="true"]')!)
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('architecture') })
    await waitFor(() => { expect(screen.queryByText('Architecture reviewer')).toBeNull() })
  })
})
