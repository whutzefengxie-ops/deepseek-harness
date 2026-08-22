import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  MockAdapter,
  textResponse,
  toolCallResponse,
} from '../../../core/agent-loop/tests/mock-adapter.ts'
import ShadowMindRuntime, { SHADOW_MIND_SETTINGS_NAMESPACE } from '../src/index.ts'
import { ReportBatcher, type AcceptedShadowReport } from '../src/report-batcher.ts'
import type { ShadowMindConfig } from '../src/types.ts'
import type { ShadowReportMessageSource } from '../src/protocol.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

interface SetupOptions {
  readonly headless?: boolean
  readonly config?: ShadowMindConfig
  readonly provider?: SubagentProvider
}

interface OwnerProbe {
  readonly batcher: ReportBatcher
  readonly epoch: number
}

interface RuntimeProbe {
  stopped: boolean
  readonly owners: Map<Agent, OwnerProbe>
  deliver(agent: Agent, state: OwnerProbe, reports: readonly AcceptedShadowReport[]): void
  releaseOwner(agent: Agent, state: OwnerProbe): Promise<void>
}

const contexts: Context[] = []

function resultProvider(
  result: Promise<SubagentResult> | SubagentResult,
  dispose: () => Promise<void> = () => Promise.resolve(),
): SubagentProvider {
  return {
    name: 'spawn',
    capabilities: {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
      modelSelection: true,
    },
    inheritsParentContext: false,
    start: () => Promise.resolve({
      id: SessionId('custom-shadow-child'),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose,
    }),
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** Mount the shipped root loop, settings provider, subagent registry, spawn provider, and Shadow runtime. */
async function setup(script: Script, options: SetupOptions = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-shadow-mind-integration-'))
  const ctx = new Context()
  contexts.push(ctx)
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FileSettingsProvider, { dshHome, watch: false })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  if (options.provider === undefined) await ctx.plugin(spawn, { providerName: 'spawn' })
  else ctx.subagents.registerProvider(options.provider)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  if (options.headless === true) ctx.provide('headlessStartup', { task: 'test' })
  const shadowFiber = await ctx.plugin(ShadowMindRuntime, {
    dshHome,
    heartbeatProbability: 1,
    resultBatchWindowMs: 0,
    defaultShadowTimeoutSeconds: 5,
    ...options.config,
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const toolName of ['read', 'grep', 'glob'] as const) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: `${toolName} one deterministic test fixture.`,
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve(toolName === 'read' ? 'ROOT_TOOL_SECRET' : ''),
    }))
  }
  await ctx.shadowMind.createDefinition({
    id: 'reviewer',
    name: 'Independent reviewer',
    enabled: true,
    debug: false,
    activationProbability: 1,
    activeForModels: [],
    runWithModel: 'mock/shadow-model',
    tools: [],
    prompt: 'Report concrete risks that the root agent can act on.',
  })
  const handle = await ctx.agents.create({
    sessionId: SessionId('shadow-root'),
    meta: { cwd: dshHome },
    agentOptions: { provider: 'mock', model: 'root-model' },
  })
  return { ctx, adapter, dshHome, handle, root: handle.agent, shadowFiber }
}

describe('Shadow Mind over the real root loop and spawn provider', () => {
  it('contains provider startup and disposal failures', async () => {
    const failingProvider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- verifies the unknown provider-rejection boundary.
      start: () => Promise.reject('provider rejected with a non-Error value'),
    }
    const failed = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], { provider: failingProvider })
    failed.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Exercise provider failure.' }], source: { kind: 'user' },
    }))
    await failed.root.whenIdle()
    await vi.waitFor(() => { expect(failed.ctx.shadowMind.status(failed.root).active).toEqual([]) })

    const resultFailure = Promise.withResolvers<SubagentResult>()
    const aggregate = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], {
      provider: resultProvider(
        resultFailure.promise,
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- verifies the unknown disposal-rejection boundary.
        () => Promise.reject('dispose rejected with a non-Error value'),
      ),
    })
    aggregate.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Exercise aggregate failure.' }], source: { kind: 'user' },
    }))
    await aggregate.root.whenIdle()
    await vi.waitFor(() => { expect(aggregate.ctx.shadowMind.status(aggregate.root).active).toHaveLength(1) })
    resultFailure.reject(new Error('result failed'))
    await vi.waitFor(() => { expect(aggregate.ctx.shadowMind.status(aggregate.root).active).toEqual([]) })

    const disposal = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], {
      provider: resultProvider(
        { output: [], stopReason: 'completed', structured: { status: 'silent', content: '' } },
        () => Promise.reject(new Error('dispose failed')),
      ),
    })
    const warned = vi.spyOn(disposal.ctx.logger, 'warn').mockImplementation(() => disposal.ctx.logger)
    disposal.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Exercise disposal failure.' }], source: { kind: 'user' },
    }))
    await disposal.root.whenIdle()
    await vi.waitFor(() => {
      expect(warned).toHaveBeenCalledWith('dsh-shadow-mind: shadow %s failed: %o', 'reviewer', expect.any(Error))
    })
  })

  it('exposes a reserved run before provider publication settles', async () => {
    const start = Promise.withResolvers<Awaited<ReturnType<SubagentProvider['start']>>>()
    const base = resultProvider({ output: [], stopReason: 'completed', structured: { status: 'silent', content: '' } })
    const provider: SubagentProvider = { ...base, start: () => start.promise }
    const { ctx, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], { provider })
    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect pending publication.' }], source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toHaveLength(1) })
    expect(ctx.shadowMind.status(root).active[0]).not.toHaveProperty('childSessionId')
    start.resolve(await base.start({} as never))
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
  })

  it('contains catalog diagnostics, catalog failures, and stale scheduling admissions', async () => {
    const diagnosed = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ])
    vi.spyOn(diagnosed.ctx.shadowMind.registry, 'list').mockResolvedValueOnce({
      definitions: [],
      diagnostics: [{ path: '/bad.md', error: 'invalid definition' }],
    })
    diagnosed.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Load diagnostics.' }], source: { kind: 'user' },
    }))
    await diagnosed.root.whenIdle()

    const failed = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ])
    vi.spyOn(failed.ctx.shadowMind.registry, 'list').mockRejectedValueOnce(new Error('catalog unavailable'))
    failed.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Fail catalog load.' }], source: { kind: 'user' },
    }))
    await failed.root.whenIdle()
    await vi.waitFor(() => { expect(failed.ctx.shadowMind.status(failed.root).pendingSchedules).toBe(0) })

    const stale = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ])
    const catalog = await stale.ctx.shadowMind.registry.list()
    const pending = Promise.withResolvers<typeof catalog>()
    vi.spyOn(stale.ctx.shadowMind.registry, 'list').mockReturnValueOnce(pending.promise)
    stale.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Pause while loading.' }], source: { kind: 'user' },
    }))
    await stale.root.whenIdle()
    await vi.waitFor(() => { expect(stale.ctx.shadowMind.status(stale.root).pendingSchedules).toBe(1) })
    stale.ctx.shadowMind.pause(stale.root)
    pending.resolve(catalog)
    await vi.waitFor(() => { expect(stale.ctx.shadowMind.status(stale.root).pendingSchedules).toBe(0) })
  })

  it('rejects an oversized report after a successful debug append', async () => {
    const { ctx, root, dshHome } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], {
      provider: resultProvider({
        output: [], stopReason: 'completed', structured: { status: 'report', content: 'TOO_LONG' },
      }),
      config: { maxReportChars: 3, randomSeed: 1 },
    })
    await ctx.shadowMind.updateDefinition('reviewer', { debug: true })
    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Write debug and reject report.' }], source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(async () => {
      expect(await readFile(join(dshHome, 'shadow-minds', 'logs', 'reviewer.jsonl'), 'utf8')).toContain('"status":"report"')
    })
    expect(ctx.shadowMind.status(root).active).toEqual([])
  })

  it.each([
    null,
    17,
    [],
    {},
    { status: 'unknown', content: '' },
    { status: 'silent', content: 17 },
    { status: 'silent', content: 'unexpected' },
  ])('rejects a malformed provider structured result %#', async (structured) => {
    const { ctx, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], { provider: resultProvider({ output: [], stopReason: 'completed', structured }) })
    await ctx.shadowMind.updateDefinition('reviewer', { debug: true })
    const debugAppend = vi.spyOn(ctx.shadowMind.registry, 'appendDebug').mockResolvedValue()

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect malformed output.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(debugAppend).toHaveBeenCalledOnce() })
    expect(ctx.shadowMind.status(root).active).toEqual([])
    expect(root.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'shadow-report')).toBe(false)
  })

  it('inherits the root route only when reasoning effort needs a complete selection', async () => {
    const starts: unknown[] = []
    const provider = resultProvider({ output: [], stopReason: 'completed', structured: { status: 'silent', content: '' } })
    const observed: SubagentProvider = {
      ...provider,
      start: (request) => {
        starts.push(request)
        return provider.start(request)
      },
    }
    const { ctx, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      toolCallResponse('read-root-2', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE_2'),
    ], { provider: observed })
    await ctx.shadowMind.updateDefinition('reviewer', { runWithModel: undefined })

    root.followup(createUserMessage({ content: [{ type: 'text', text: 'No override.' }], source: { kind: 'user' } }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(starts).toHaveLength(1) })
    expect(starts[0]).not.toHaveProperty('modelSelection')

    await ctx.shadowMind.updateDefinition('reviewer', { reasoningEffort: 'high' })
    root.followup(createUserMessage({ content: [{ type: 'text', text: 'Effort override.' }], source: { kind: 'user' } }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(starts).toHaveLength(2) })
    expect(starts[1]).toMatchObject({
      modelSelection: { provider: 'mock', model: 'root-model', reasoningEffort: 'high' },
    })
  })

  it('fails a reasoning-only selection when the root has no complete route', async () => {
    const { ctx } = await setup([], {
      provider: resultProvider({ output: [], stopReason: 'completed', structured: { status: 'silent', content: '' } }),
    })
    await ctx.shadowMind.updateDefinition('reviewer', { runWithModel: undefined, reasoningEffort: 'high' })
    const catalog = await ctx.shadowMind.registry.list()
    for (const [suffix, agentOptions] of [
      ['missing-route', undefined],
      ['partial-route', { provider: 'mock' }],
      ['invalid-route', { provider: '', model: 'root-model' }],
    ] as const) {
      const handle = await ctx.agents.create({
        sessionId: SessionId(`route-less-shadow-root-${suffix}`),
        ...agentOptions === undefined ? {} : { agentOptions },
      })
      const root = handle.agent
      const pending = Promise.withResolvers<typeof catalog>()
      vi.spyOn(ctx.shadowMind.registry, 'list').mockReturnValueOnce(pending.promise)
      root.session.append('turn/start', { turn: 1 })
      const call = root.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId(`manual-read-${suffix}`),
        name: 'read',
        arguments: '{}',
      })
      root.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId(`manual-read-${suffix}`),
          content: [{ type: 'text', text: 'result' }],
          isError: false,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(ctx.shadowMind.status(root).pendingSchedules).toBe(1) })
      pending.resolve(catalog)
      await vi.waitFor(() => { expect(ctx.shadowMind.status(root).pendingSchedules).toBe(0) })
      expect(ctx.shadowMind.status(root).active).toEqual([])
      await handle.dispose()
    }
  })

  it('rejects oversized reports and contains debug-log write failures', async () => {
    const provider = resultProvider({
      output: [],
      stopReason: 'completed',
      structured: { status: 'report', content: 'TOO_LONG' },
    })
    const { ctx, dshHome, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], { provider, config: { maxReportChars: 3 } })
    await ctx.shadowMind.updateDefinition('reviewer', { debug: true })
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const logs = join(dshHome, 'shadow-minds', 'logs')
    await mkdir(join(dshHome, 'shadow-minds'), { recursive: true })
    await writeFile(logs, 'blocks debug directory creation')

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Reject an oversized report.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => {
      expect(warned).toHaveBeenCalledWith(
        'dsh-shadow-mind: failed to write debug log for %s: %o',
        'reviewer',
        expect.any(Error),
      )
    })
    expect(ctx.shadowMind.status(root).active).toEqual([])
    expect(root.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'shadow-report')).toBe(false)
  })

  it('holds headless idle through a report relay and root follow-up', async () => {
    const { adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      toolCallResponse('shadow-report', STRUCTURED_OUTPUT_TOOL, {
        status: 'report',
        content: 'HEADLESS_SHADOW_REPORT',
      }),
      textResponse('ROOT_USED_HEADLESS_REPORT'),
    ], { headless: true, config: { headlessDrainTimeoutSeconds: 1 } })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect in headless mode.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()

    expect(adapter.requests).toHaveLength(4)
    expect(root.session.events.some(event => event.type === 'assistant/message'
      && JSON.stringify(event.data).includes('ROOT_USED_HEADLESS_REPORT'))).toBe(true)
  })

  it('cancels a hung child at the headless drain deadline', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      'hang',
    ], {
      headless: true,
      config: { headlessDrainTimeoutSeconds: 0.01, defaultShadowTimeoutSeconds: 5 },
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start a hung Shadow.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(ctx.shadowMind.status(root).active).toEqual([])
    expect(ctx.shadowMind.status(root).epoch).toBeGreaterThan(0)
  })

  it('lets the per-Shadow deadline abort a hung child', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      'hang',
    ], { config: { defaultShadowTimeoutSeconds: 0.01 } })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start a timed Shadow.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
  })

  it('cancels headless maintenance through its abort signal', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      'hang',
    ], {
      headless: true,
      config: { headlessDrainTimeoutSeconds: 5, defaultShadowTimeoutSeconds: 5 },
    })
    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Abort headless maintenance.' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    root.cancel({ kind: 'user' })
    await root.whenIdle()
    expect(ctx.shadowMind.status(root).active).toEqual([])
    expect(ctx.shadowMind.status(root).epoch).toBeGreaterThan(0)
  })

  it('contains synchronous and asynchronous headless maintenance failures', async () => {
    const sync = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], { headless: true })
    const syncWarn = vi.spyOn(sync.ctx.logger, 'warn').mockImplementation(() => sync.ctx.logger)
    vi.spyOn(sync.root, 'runMaintenance').mockImplementationOnce(() => {
      throw new Error('maintenance claim failed')
    })
    sync.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Fail maintenance claim.' }], source: { kind: 'user' },
    }))
    await sync.root.whenIdle()
    await vi.waitFor(() => {
      expect(syncWarn).toHaveBeenCalledWith('dsh-shadow-mind: could not claim headless maintenance: %o', expect.any(Error))
    })

    const asyncFailure = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], { headless: true })
    const asyncWarn = vi.spyOn(asyncFailure.ctx.logger, 'warn').mockImplementation(() => asyncFailure.ctx.logger)
    vi.spyOn(asyncFailure.root, 'runMaintenance').mockReturnValueOnce(Promise.reject(new Error('maintenance failed')))
    asyncFailure.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Reject maintenance.' }], source: { kind: 'user' },
    }))
    await asyncFailure.root.whenIdle()
    await vi.waitFor(() => {
      expect(asyncWarn).toHaveBeenCalledWith('dsh-shadow-mind: headless maintenance failed: %o', expect.any(Error))
    })
  })

  it('exposes definition, live-settings, and root-only control APIs', async () => {
    const { ctx, root } = await setup([])
    expect(ctx.shadowMind.status(root)).toEqual({ paused: false, active: [], pendingSchedules: 0, epoch: 0 })
    expect((await ctx.shadowMind.listDefinitions()).definitions.map(item => item.id)).toEqual(['reviewer'])
    expect(await ctx.shadowMind.updateDefinition('reviewer', { name: 'Updated reviewer' }))
      .toMatchObject({ name: 'Updated reviewer' })
    expect(await ctx.shadowMind.setEnabled('reviewer', false)).toMatchObject({ enabled: false })
    expect(ctx.shadowMind.pause(root).paused).toBe(true)
    expect(ctx.shadowMind.pause(root).paused).toBe(true)
    expect(ctx.shadowMind.toggle(root).paused).toBe(false)
    expect(ctx.shadowMind.toggle(root).paused).toBe(true)
    expect(ctx.shadowMind.resume(root).paused).toBe(false)
    expect(ctx.shadowMind.currentSettings().randomSeed).toBeUndefined()
    await ctx.shadowMind.updateSettings({ randomSeed: 17, maxParallelShadows: 2 })
    expect(ctx.shadowMind.currentSettings()).toMatchObject({ randomSeed: 17, maxParallelShadows: 2 })
    await ctx.shadowMind.updateSettings({ randomSeed: 18 })
    expect(ctx.shadowMind.currentSettings().randomSeed).toBe(18)
    await ctx.shadowMind.updateSettings({ maxParallelShadows: 3 })
    expect(ctx.shadowMind.currentSettings().maxParallelShadows).toBe(3)
    await ctx.settings.replace(SHADOW_MIND_SETTINGS_NAMESPACE, {})
    expect(ctx.shadowMind.currentSettings().randomSeed).toBeUndefined()
    await ctx.shadowMind.deleteDefinition('reviewer')
    expect((await ctx.shadowMind.listDefinitions()).definitions).toEqual([])

    const childSession = ctx.sessions.create(SessionId('shadow-api-child'), {
      meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 },
    })
    const child = { session: childSession } as Agent
    expect(() => ctx.shadowMind.status(child)).toThrow('available only on root agents')
  })

  it('cancels only user-aborted root turns at the durable event boundary', async () => {
    const { ctx, root } = await setup([])
    root.session.append('turn/start', { turn: 1 })
    root.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'legacy' } },
    })
    expect(ctx.shadowMind.status(root).epoch).toBe(0)
    root.session.append('turn/start', { turn: 2 })
    root.session.append('turn/end', {
      turn: 2,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(ctx.shadowMind.status(root).epoch).toBe(1)
  })

  it('filters stale deliveries, steers a running root, and rejects stale root identities', async () => {
    const { ctx, root } = await setup([])
    ctx.shadowMind.pause(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const report: AcceptedShadowReport = {
      epoch: state.epoch,
      shadowId: 'reviewer',
      shadowName: 'Independent reviewer',
      runId: 'delivery-run',
      childSessionId: SessionId('delivery-child'),
      capturedThroughSeq: 1,
      content: 'Actionable finding.',
    }
    const steer = vi.spyOn(root, 'steer').mockImplementation(() => undefined)
    vi.spyOn(root, 'status', 'get').mockReturnValue('running')

    runtime.deliver(root, state, [{ ...report, epoch: state.epoch - 1 }])
    expect(steer).not.toHaveBeenCalled()
    runtime.deliver(root, state, [report])
    expect(steer).toHaveBeenCalledOnce()

    runtime.stopped = true
    runtime.deliver(root, state, [report])
    runtime.stopped = false
    runtime.deliver({ id: root.id } as Agent, state, [report])
    expect(steer).toHaveBeenCalledOnce()
  })

  it('contains owner release failures and reuses the settled release', async () => {
    const single = await setup([])
    single.ctx.shadowMind.pause(single.root)
    const singleRuntime = single.ctx.shadowMind as unknown as RuntimeProbe
    const singleState = singleRuntime.owners.get(single.root)!
    vi.spyOn(singleState.batcher, 'drain').mockRejectedValueOnce(new Error('drain failed'))
    await expect(singleRuntime.releaseOwner(single.root, singleState)).rejects.toThrow('drain failed')
    await expect(singleRuntime.releaseOwner(single.root, singleState)).rejects.toThrow('drain failed')

    const aggregate = await setup([])
    aggregate.ctx.shadowMind.pause(aggregate.root)
    const aggregateRuntime = aggregate.ctx.shadowMind as unknown as RuntimeProbe
    const aggregateState = aggregateRuntime.owners.get(aggregate.root)!
    vi.spyOn(aggregateState.batcher, 'drain').mockRejectedValueOnce(new Error('drain failed'))
    vi.spyOn(aggregateState.batcher, 'dispose').mockRejectedValueOnce(new Error('dispose failed'))
    await expect(aggregateRuntime.releaseOwner(aggregate.root, aggregateState))
      .rejects.toThrow('Shadow owner release failed')

    const disposed = await setup([])
    disposed.ctx.shadowMind.pause(disposed.root)
    const disposedRuntime = disposed.ctx.shadowMind as unknown as RuntimeProbe
    const disposedState = disposedRuntime.owners.get(disposed.root)!
    vi.spyOn(disposedState.batcher, 'drain').mockRejectedValueOnce(new Error('root release failed'))
    const warn = vi.spyOn(disposed.ctx.logger, 'warn').mockImplementation(() => disposed.ctx.logger)
    await disposed.handle.dispose()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('dsh-shadow-mind: root release failed: %o', expect.any(Error))
    })
  })

  it('relays one structured fresh-child report with durable provenance', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'ROOT_ARGUMENT_SECRET' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      toolCallResponse('shadow-report', STRUCTURED_OUTPUT_TOOL, {
        status: 'report',
        content: 'SHADOW_ACTIONABLE_FINDING',
      }),
      textResponse('ROOT_USED_SHADOW_REPORT'),
    ])
    const relayed = Promise.withResolvers<SessionEvent<'user/message'>>()
    let childPolicy: SessionEvent<'approval/policy'> | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== root.id) return
      childPolicy = agent.session.events.find((event): event is SessionEvent<'approval/policy'> => event.type === 'approval/policy')
    })
    ctx.on('session/event', (session, event) => {
      if (session.id === root.id && event.type === 'user/message' && event.data.source.kind === 'shadow-report') {
        relayed.resolve(event)
      }
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect the fixture.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(3) })
    const relay = await relayed.promise
    await root.whenIdle()

    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests[2]).toMatchObject({ provider: 'mock', model: 'shadow-model' })
    const childPrompt = JSON.stringify(adapter.requests[2]?.messages)
    expect(childPrompt).toContain('Report concrete risks that the root agent can act on.')
    expect(childPrompt).toContain('read success: 1 non-empty lines, 16 text characters')
    expect(childPrompt).toContain('arguments=[redacted]')
    expect(childPrompt).not.toContain('ROOT_ARGUMENT_SECRET')
    expect(childPrompt).not.toContain('ROOT_TOOL_SECRET')

    const source = relay.data.source as ShadowReportMessageSource
    expect(source.kind).toBe('shadow-report')
    expect(source.form).toBe('relay')
    expect(source.reports).toHaveLength(1)
    const firstReport = source.reports[0]
    expect(firstReport?.shadowId).toBe('reviewer')
    expect(typeof firstReport?.capturedThroughSeq).toBe('number')
    expect(firstReport?.runId).not.toBe('')
    expect(String(firstReport?.childSessionId)).not.toBe('')
    expect(childPolicy).toMatchObject({
      type: 'approval/policy',
      data: { policy: 'never', source: 'delegation' },
    })
    expect(firstReport?.capturedThroughSeq).toBeLessThan(relay.seq)
    expect(JSON.stringify(relay.data.content)).toContain('SHADOW_ACTIONABLE_FINDING')
    expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('SHADOW_ACTIONABLE_FINDING')
    expect(root.session.events.some(event => event.type === 'assistant/message'
      && JSON.stringify(event.data.message.content).includes('ROOT_USED_SHADOW_REPORT'))).toBe(true)
  })

  it('cancels an active Shadow on new root user input and rejects its stale result', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      'hang',
      textResponse('ROOT_NEW_INPUT_DONE'),
    ])
    const childStarted = Promise.withResolvers<undefined>()
    const relays: SessionEvent<'user/message'>[] = []
    ctx.on('subagent/start', () => { childStarted.resolve(undefined) })
    ctx.on('session/event', (session, event) => {
      if (session.id === root.id && event.type === 'user/message' && event.data.source.kind === 'shadow-report') {
        relays.push(event)
      }
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start the first turn.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(3) })
    await childStarted.promise
    expect(ctx.shadowMind.status(root).active).toHaveLength(1)

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'This newer instruction supersedes background analysis.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toHaveLength(0) })

    expect(adapter.requests).toHaveLength(4)
    expect(relays).toEqual([])
    expect(ctx.shadowMind.status(root).epoch).toBeGreaterThanOrEqual(2)
  })

  it.each([
    ['silent', 'unexpected content'],
    ['report', '   '],
  ] as const)('rejects an invalid %s structured-result relationship', async (status, content) => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      toolCallResponse('shadow-result', STRUCTURED_OUTPUT_TOOL, { status, content }),
    ])
    const relays: SessionEvent<'user/message'>[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === root.id && event.type === 'user/message' && event.data.source.kind === 'shadow-report') {
        relays.push(event)
      }
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect the fixture.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toHaveLength(0) })
    expect(relays).toEqual([])
  })

  it('shares one quiescent release across concurrent root and plugin disposal', async () => {
    const { ctx, adapter, handle, root, shadowFiber } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      'hang',
    ])
    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start background analysis.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })

    await Promise.all([handle.dispose(), shadowFiber.dispose()])
    expect(ctx.agents.get(root.id)).toBeUndefined()
  })
})
