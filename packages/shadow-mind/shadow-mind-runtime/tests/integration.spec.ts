import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
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
  spentChars: number
}

interface RuntimeProbe {
  stopped: boolean
  readonly owners: Map<Agent, OwnerProbe>
  deliver(agent: Agent, state: OwnerProbe, reports: readonly AcceptedShadowReport[]): Promise<void>
  releaseOwner(agent: Agent, state: OwnerProbe): Promise<void>
  nextReasoningEffort(current: string | undefined): string | undefined
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
      contextInheritance: true,
      thinkFirst: true,
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

function appendManualToolTurn(root: Agent, turn: number): number {
  root.session.append('turn/start', { turn })
  const callId = CallId(`manual-read-${String(turn)}`)
  const call = root.session.append('tool/call', {
    turn,
    step: 1,
    callId,
    name: 'read',
    arguments: '{}',
  })
  root.session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: `result ${String(turn)}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  root.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return call.seq
}

function acceptedReport(
  epoch: number,
  runId: string,
  verdict: 'challenge' | 'confirm' | 'gap',
  severity?: number,
): AcceptedShadowReport {
  return {
    epoch,
    shadowId: `${verdict}-reviewer`,
    shadowName: `${verdict} reviewer`,
    runId,
    childSessionId: SessionId(`${runId}-child`),
    capturedThroughSeq: 1,
    content: `${verdict} original report`,
    verdict,
    ...severity === undefined ? {} : { severity },
    refs: [],
  }
}

describe('Shadow Mind over the real root loop and spawn provider', () => {
  it('contains provider startup and disposal failures', async () => {
    const failingProvider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      // A non-Error rejection exercises provider-rejection normalization.
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
    await vi.waitFor(() => { expect(failed.ctx.shadowMind.status(failed.root).totalRuns).toBe(1) })
    await vi.waitFor(() => { expect(failed.ctx.shadowMind.status(failed.root).active).toEqual([]) })
    expect(failed.ctx.shadowMind.status(failed.root)).toMatchObject({
      totalRuns: 1,
      lastRun: { shadowId: 'reviewer', outcome: 'failed' },
    })

    const resultFailure = Promise.withResolvers<SubagentResult>()
    const aggregate = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
    ], {
      provider: resultProvider(
        resultFailure.promise,
        // A non-Error rejection exercises disposal-rejection normalization.
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
        output: [], stopReason: 'completed', structured: {
          status: 'report', content: 'TOO_LONG', verdict: 'challenge', refs: [],
        },
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
    expect(ctx.shadowMind.status(root)).toMatchObject({
      totalRuns: 1,
      lastRun: { shadowId: 'reviewer', outcome: 'discarded' },
    })
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

  it('validates report severity and durable sequence anchors before relay', async () => {
    const providerState: { root?: Agent } = {}
    const cases: ((anchor: number) => unknown)[] = [
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', severity: 'high', refs: [] }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', severity: Number.NaN, refs: [] }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', severity: -1, refs: [] }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', severity: 2, refs: [] }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', refs: 'not-an-array' }),
      () => ({
        status: 'report', content: 'finding', verdict: 'challenge', refs: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', refs: [1.5] }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', refs: [0] }),
      anchor => ({ status: 'report', content: 'finding', verdict: 'challenge', refs: [anchor, anchor] }),
      () => ({ status: 'report', content: 'finding', verdict: 'challenge', refs: [999_999] }),
      () => ({ status: 'report', content: 'unanchored finding', verdict: 'gap' }),
      anchor => ({ status: 'report', content: 'anchored finding', verdict: 'confirm', severity: 0.5, refs: [anchor] }),
    ]
    let attempt = 0
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: () => {
        const root = providerState.root
        if (root === undefined) throw new Error('root was not published before Shadow startup')
        const anchor = [...root.session.events].reverse()
          .find(event => event.type === 'tool/call')?.seq
        if (anchor === undefined) throw new Error('manual tool turn did not publish an anchor')
        const structured = cases[attempt]?.(anchor)
        attempt += 1
        return Promise.resolve({
          id: SessionId(`validated-output-${String(attempt)}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' as const, structured }),
          dispose: () => Promise.resolve(),
        })
      },
    }
    const fixture = await setup([], { provider })
    providerState.root = fixture.root
    const followup = vi.spyOn(fixture.root, 'followup').mockImplementation(() => undefined)

    for (let turn = 1; turn <= cases.length; turn += 1) {
      appendManualToolTurn(fixture.root, turn)
      await vi.waitFor(() => { expect(fixture.ctx.shadowMind.status(fixture.root).totalRuns).toBe(turn) })
      await vi.waitFor(() => { expect(fixture.ctx.shadowMind.status(fixture.root).active).toEqual([]) })
    }
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })
    expect(JSON.stringify(followup.mock.calls)).toContain('anchored finding')
    expect(fixture.ctx.shadowMind.status(fixture.root).lastRun).toMatchObject({
      outcome: 'report',
      verdict: 'confirm',
    })
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

  it('skips a selected run before provider startup when a configured prefilter matches', async () => {
    const provider = resultProvider({
      output: [], stopReason: 'completed', structured: { status: 'silent', content: '' },
    })
    const start = vi.spyOn(provider, 'start')
    const { ctx, root } = await setup([], { provider, config: { randomSeed: 1 } })
    await ctx.shadowMind.updateDefinition('reviewer', { debug: true, preFilters: ['tool-failure'] })
    const debug = vi.spyOn(ctx.shadowMind.registry, 'appendDebug').mockResolvedValue()
    root.session.append('turn/start', { turn: 1 })
    const call = root.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('failed-read'),
      name: 'read',
      arguments: '{}',
    })
    root.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('failed-read'),
        content: [{ type: 'text', text: 'failed' }],
        isError: true,
      }),
      error: { name: 'FixtureError', code: 'fixture_failure' },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).pendingSchedules).toBe(0) })
    expect(start).not.toHaveBeenCalled()
    expect(ctx.shadowMind.status(root)).toMatchObject({ totalRuns: 0, prefilterSkips: 1 })
    expect(debug).toHaveBeenCalledWith('reviewer', expect.objectContaining({
      status: 'prefilter_skip',
      predicate: 'tool-failure',
    }))
  })

  it('applies a deterministic boost while evaluating independent-vendor preference', async () => {
    const provider = resultProvider({
      output: [], stopReason: 'completed', structured: { status: 'silent', content: '' },
    })
    const start = vi.spyOn(provider, 'start')
    const { ctx, root } = await setup([], {
      provider,
      config: { preferIndependentVendor: true, longOutputBoostChars: 1 },
    })
    await ctx.shadowMind.updateDefinition('reviewer', {
      activationProbability: 0.5,
      boostFilters: ['long-output'],
      boostFactor: 2,
    })

    appendManualToolTurn(root, 1)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(1) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })

    expect(start).toHaveBeenCalledOnce()
    expect(ctx.shadowMind.status(root).effectiveProbabilities).toEqual([
      { shadowId: 'reviewer', probability: 1 },
    ])
  })

  it('records startup failure when a holdout sidecar disappears before the run', async () => {
    const { ctx, dshHome, root } = await setup([], {
      provider: resultProvider({
        output: [], stopReason: 'completed', structured: { status: 'silent', content: '' },
      }),
    })
    const sidecar = join(dshHome, 'shadow-minds', 'holdout-keys.json')
    await writeFile(sidecar, JSON.stringify({ reviewer: ['OWNER_LITERAL'] }))
    await ctx.shadowMind.updateDefinition('reviewer', { holdout: true })
    const catalog = await ctx.shadowMind.registry.list()
    vi.spyOn(ctx.shadowMind.registry, 'list').mockResolvedValueOnce(catalog)
    await unlink(sidecar)

    appendManualToolTurn(root, 1)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(1) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    expect(ctx.shadowMind.status(root).lastRun).toMatchObject({ outcome: 'failed' })
  })

  it('discards a completed report after pause invalidates its admitted epoch', async () => {
    const deferred = Promise.withResolvers<SubagentResult>()
    const { ctx, root } = await setup([], { provider: resultProvider(deferred.promise) })
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    appendManualToolTurn(root, 1)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toHaveLength(1) })
    ctx.shadowMind.pause(root)
    deferred.resolve({
      output: [],
      stopReason: 'completed',
      structured: { status: 'report', content: 'stale finding', verdict: 'gap', refs: [] },
    })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })

    expect(followup).not.toHaveBeenCalled()
    expect(ctx.shadowMind.status(root).lastRun).toMatchObject({ outcome: 'discarded' })
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
      structured: { status: 'report', content: 'TOO_LONG', verdict: 'challenge', refs: [] },
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
        verdict: 'challenge',
        refs: [],
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

  it('records a metadata-only adopted challenge without changing relay behavior', async () => {
    const { ctx, dshHome, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      toolCallResponse('shadow-report', STRUCTURED_OUTPUT_TOOL, {
        status: 'report',
        content: 'VALUE_LOOP_FINDING_TEXT',
        verdict: 'challenge',
        refs: [],
      }),
      textResponse('I adopted the Shadow report and updated the implementation.'),
    ], { config: { valueLoopWindowTurns: 1 } })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Exercise value diagnostics.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => {
      expect(ctx.shadowMind.status(root).valueLoop).toEqual([{
        shadowId: 'reviewer',
        challenges: 1,
        adopted: 1,
        rejected: 0,
        ignored: 0,
        hitRate: 1,
      }])
    })
    const journal = await readFile(join(dshHome, 'shadow-minds', 'value-loop.jsonl'), 'utf8')
    expect(journal).toContain('"classification":"challenge_adopted"')
    expect(journal).not.toMatch(/VALUE_LOOP_FINDING_TEXT|adopted the Shadow report/)
  })

  it('classifies rejected and ignored challenges while containing journal failures', async () => {
    const disabled = await setup([], { config: { valueLoopEnabled: false } })
    disabled.root.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'disabled challenge' }],
      source: {
        kind: 'shadow-report',
        form: 'relay',
        reports: [{
          shadowId: 'reviewer',
          runId: 'disabled-run',
          childSessionId: SessionId('disabled-child'),
          capturedThroughSeq: 0,
          verdict: 'challenge',
        }],
      },
    }), { surfaceOp: 'append' })
    disabled.root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(disabled.ctx.shadowMind.status(disabled.root).valueLoop).toEqual([])

    const { ctx, root } = await setup([], { config: { valueLoopWindowTurns: 1 } })
    const appendChallenge = (runId: string): void => {
      root.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'challenge relay' }],
        source: {
          kind: 'shadow-report',
          form: 'relay',
          reports: [{
            shadowId: 'reviewer',
            runId,
            childSessionId: SessionId(`${runId}-child`),
            capturedThroughSeq: 0,
            verdict: 'challenge',
          }],
        },
      }), { surfaceOp: 'append' })
    }
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    vi.spyOn(ctx.shadowMind.registry, 'appendValueLoop')
      .mockRejectedValue(new Error('value journal unavailable'))

    appendChallenge('rejected-run')
    root.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'The Shadow report is incorrect.' }],
        source: { kind: 'model', provider: 'mock', model: 'root-model' },
      }),
    }, { surfaceOp: 'append' })
    root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendChallenge('ignored-run')
    root.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(ctx.shadowMind.status(root).valueLoop).toEqual([{
        shadowId: 'reviewer',
        challenges: 2,
        adopted: 0,
        rejected: 1,
        ignored: 1,
        hitRate: 0,
      }])
    })
    await vi.waitFor(() => {
      expect(warned).toHaveBeenCalledWith(
        'dsh-shadow-mind: failed to write value-loop log: %o',
        expect.any(Error),
      )
    })
  })

  it('applies minimal context and think-first through the real spawn provider', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      textResponse('Plan: challenge projected sequence 3 after checking its evidence.'),
      toolCallResponse('shadow-report', STRUCTURED_OUTPUT_TOOL, {
        status: 'report',
        content: 'CONDITIONED_SHADOW_FINDING',
        verdict: 'gap',
        refs: [],
      }),
      textResponse('ROOT_USED_CONDITIONED_REPORT'),
    ])
    await ctx.shadowMind.updateDefinition('reviewer', {
      context: 'minimal',
      thinkFirst: true,
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Exercise conditioned review.' }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(4) })
    await root.whenIdle()

    expect(adapter.requests).toHaveLength(5)
    expect(adapter.requests[2]?.tools).toBeUndefined()
    expect(adapter.requests[3]?.tools?.map(tool => tool.name)).toEqual([
      'glob', 'grep', 'read', 'structured_output',
    ])
    expect(JSON.stringify(adapter.requests[2]?.messages)).not.toMatch(
      /delegated subagent|Approval prompts are disabled/,
    )
    expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('Planning is complete')
    expect(root.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'shadow-report'
      && JSON.stringify(event.data.content).includes('CONDITIONED_SHADOW_FINDING'))).toBe(true)
  })

  it('downgrades to the frugal route before the hard budget stops later runs', async () => {
    const starts: Parameters<SubagentProvider['start']>[0][] = []
    const provider = resultProvider({
      output: [],
      stopReason: 'completed',
      structured: { status: 'report', content: 'budget finding', verdict: 'gap', refs: [] },
    })
    const observed: SubagentProvider = {
      ...provider,
      start: (request) => {
        starts.push(request)
        return provider.start(request)
      },
    }
    const { ctx, root } = await setup([], {
      provider: observed,
      config: {
        resultBatchWindowMs: 0,
        sessionShadowSoftBudgetChars: 1,
        sessionShadowHardBudgetChars: 1_000_000,
        frugalShadowModel: 'deepseek/frugal-reviewer',
      },
    })
    vi.spyOn(root, 'followup').mockImplementation(() => undefined)

    appendManualToolTurn(root, 1)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(1) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    expect(ctx.shadowMind.status(root).budgetTier).toBe('frugal')

    appendManualToolTurn(root, 2)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(2) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    expect(starts.map(request => request.modelSelection?.provider)).toEqual(['mock', 'deepseek'])
    expect(starts[1]?.modelSelection?.model).toBe('frugal-reviewer')

    const spent = ctx.shadowMind.status(root).spentChars
    await ctx.shadowMind.updateSettings({ sessionShadowHardBudgetChars: spent })
    expect(ctx.shadowMind.status(root).budgetTier).toBe('exhausted')
    appendManualToolTurn(root, 3)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(ctx.shadowMind.status(root).totalRuns).toBe(2)

    ctx.emit('agent/inbox/inserted', {
      agent: root,
      message: createUserMessage({ content: [{ type: 'text', text: 'new task' }], source: { kind: 'user' } }),
    })
    expect(ctx.shadowMind.status(root)).toMatchObject({ spentChars: 0, budgetTier: 'standard' })
  })

  it('expires stagnation cooldowns by wall clock and clears them on pause or resume', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const provider = resultProvider({
      output: [],
      stopReason: 'completed',
      structured: { status: 'report', content: 'same finding', verdict: 'gap', refs: [] },
    })
    const { ctx, root } = await setup([], {
      provider,
      config: {
        resultBatchWindowMs: 0,
        reviewWindowSize: 6,
        spinningRepeatCount: 2,
        oscillationPeriods: 2,
        noDriftRepeatCount: 3,
        diminishingWindowSize: 5,
        diminishingNoveltyThreshold: 0,
        stagnationCooldownSeconds: 10,
      },
    })
    vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    appendManualToolTurn(root, 1)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(1) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    appendManualToolTurn(root, 2)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(2) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).cooldowns).toHaveLength(1) })

    appendManualToolTurn(root, 3)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(ctx.shadowMind.status(root).totalRuns).toBe(2)

    ctx.shadowMind.pause(root)
    expect(ctx.shadowMind.status(root).cooldowns).toEqual([])
    ctx.shadowMind.resume(root)
    appendManualToolTurn(root, 4)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(3) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).cooldowns).toHaveLength(1) })

    vi.mocked(Date.now).mockReturnValue(11_001)
    appendManualToolTurn(root, 5)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(4) })
  })

  it('decays repeated envelopes and restores probability on real user input', async () => {
    const provider = resultProvider({
      output: [],
      stopReason: 'completed',
      structured: { status: 'report', content: 'repeated finding', verdict: 'gap', refs: [] },
    })
    const { ctx, root } = await setup([], {
      provider,
      config: {
        resultBatchWindowMs: 0,
        staleReportDecay: 0.5,
        reviewWindowSize: 10,
        spinningRepeatCount: 10,
        oscillationPeriods: 5,
        noDriftRepeatCount: 10,
        diminishingWindowSize: 10,
        diminishingNoveltyThreshold: 0,
      },
    })
    vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    appendManualToolTurn(root, 1)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(1) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    appendManualToolTurn(root, 2)
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(2) })
    await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    appendManualToolTurn(root, 3)
    await vi.waitFor(() => {
      expect(ctx.shadowMind.status(root).effectiveProbabilities).toEqual([
        { shadowId: 'reviewer', probability: 0.5 },
      ])
    })

    ctx.emit('agent/inbox/inserted', {
      agent: root,
      message: createUserMessage({ content: [{ type: 'text', text: 'new task' }], source: { kind: 'user' } }),
    })
    appendManualToolTurn(root, 4)
    await vi.waitFor(() => {
      expect(ctx.shadowMind.status(root).effectiveProbabilities).toEqual([
        { shadowId: 'reviewer', probability: 1 },
      ])
    })
  })

  it('retains only the configured per-definition review window', async () => {
    const providerState: { root?: Agent } = {}
    let attempt = 0
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: () => {
        const root = providerState.root
        if (root === undefined) throw new Error('root was not published before Shadow startup')
        const anchor = [...root.session.events].reverse()
          .find(event => event.type === 'tool/call')?.seq
        if (anchor === undefined) throw new Error('manual tool turn did not publish an anchor')
        attempt += 1
        return Promise.resolve({
          id: SessionId(`review-window-${String(attempt)}`),
          localAgent: undefined,
          result: Promise.resolve({
            output: [],
            stopReason: 'completed' as const,
            structured: { status: 'report', content: `finding ${String(attempt)}`, verdict: 'gap', refs: [anchor] },
          }),
          dispose: () => Promise.resolve(),
        })
      },
    }
    const fixture = await setup([], {
      provider,
      config: {
        reviewWindowSize: 4,
        spinningRepeatCount: 4,
        oscillationPeriods: 2,
        noDriftRepeatCount: 4,
        diminishingWindowSize: 4,
        diminishingNoveltyThreshold: 0,
        stagnationCooldownSeconds: 0,
      },
    })
    providerState.root = fixture.root
    vi.spyOn(fixture.root, 'followup').mockImplementation(() => undefined)

    let firstRunId: string | undefined
    for (let turn = 1; turn <= 5; turn += 1) {
      appendManualToolTurn(fixture.root, turn)
      await vi.waitFor(() => { expect(fixture.ctx.shadowMind.status(fixture.root).totalRuns).toBe(turn) })
      await vi.waitFor(() => { expect(fixture.ctx.shadowMind.status(fixture.root).active).toEqual([]) })
      firstRunId ??= fixture.ctx.shadowMind.status(fixture.root).recentReviews[0]?.runId
    }

    const reviews = fixture.ctx.shadowMind.status(fixture.root).recentReviews
    expect(reviews).toHaveLength(4)
    expect(firstRunId).toBeDefined()
    expect(reviews.map(review => review.runId)).not.toContain(firstRunId)
    expect(reviews.map(review => review.capturedThroughSeq)).toEqual(
      [...reviews.map(review => review.capturedThroughSeq)].sort((left, right) => left - right),
    )
  })

  it('uses an escalation rung before cooldown for an oscillating headless reviewer', async () => {
    const verdicts = ['challenge', 'confirm', 'challenge', 'confirm', 'gap'] as const
    const starts: Parameters<SubagentProvider['start']>[0][] = []
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: (request) => {
        starts.push(request)
        const verdict = verdicts[starts.length - 1] ?? 'gap'
        return resultProvider({
          output: [],
          stopReason: 'completed',
          structured: { status: 'report', content: `${verdict} finding`, verdict, refs: [] },
        }).start(request)
      },
    }
    const { ctx, root } = await setup([], {
      headless: true,
      provider,
      config: {
        resultBatchWindowMs: 0,
        stagnationEscalationEnabled: true,
        defaultReasoningEffort: 'low',
        reasoningEffortLadder: ['low', 'high'],
        reviewWindowSize: 8,
        spinningRepeatCount: 8,
        oscillationPeriods: 2,
        noDriftRepeatCount: 8,
        diminishingWindowSize: 8,
        diminishingNoveltyThreshold: 0,
      },
    })
    vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    for (let turn = 1; turn <= 4; turn += 1) {
      appendManualToolTurn(root, turn)
      await vi.waitFor(() => { expect(ctx.shadowMind.status(root).totalRuns).toBe(turn) })
      await vi.waitFor(() => { expect(ctx.shadowMind.status(root).active).toEqual([]) })
    }
    expect(ctx.shadowMind.status(root)).toMatchObject({
      cooldowns: [],
      pendingEscalations: ['reviewer'],
    })
    appendManualToolTurn(root, 5)
    await vi.waitFor(() => { expect(starts).toHaveLength(5) })
    expect(starts[4]?.modelSelection?.reasoningEffort).toBe('high')
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
    const { ctx, dshHome, root } = await setup([])
    expect(ctx.shadowMind.status(root)).toEqual({
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
    })
    expect((await ctx.shadowMind.listDefinitions()).definitions.map(item => item.id)).toEqual(['reviewer'])
    await expect(ctx.shadowMind.remoteExportCatalog()).resolves.toMatchObject({
      definitionRoot: join(dshHome, 'shadow-minds'),
      definitions: [{ id: 'reviewer' }],
      diagnostics: [],
    })
    await expect(ctx.shadowMind.remoteExportCreate({
      id: 'browser-reviewer',
      name: 'Browser reviewer',
      enabled: true,
      debug: false,
      activationProbability: 0.4,
      activeForModels: ['mock/*'],
      runWithModel: 'mock/browser-create',
      reasoningEffort: 'medium',
      timeoutSeconds: 6,
      tools: [],
      capture: 'full',
      context: 'standard',
      thinkFirst: false,
      preFilters: [],
      boostFilters: [],
      boostFactor: 1,
      holdout: false,
      prompt: 'Review the current root trajectory.',
    })).resolves.toMatchObject({
      id: 'browser-reviewer',
      runWithModel: 'mock/browser-create',
      reasoningEffort: 'medium',
      timeoutSeconds: 6,
    })
    await expect(ctx.shadowMind.remoteExportCreate({
      id: 'browser-minimal',
      name: 'Browser minimal',
      enabled: false,
      debug: false,
      activationProbability: 0,
      activeForModels: [],
      runWithModel: null,
      reasoningEffort: null,
      timeoutSeconds: null,
      tools: [],
      capture: 'full',
      context: 'standard',
      thinkFirst: false,
      preFilters: [],
      boostFilters: [],
      boostFactor: 1,
      holdout: false,
      prompt: 'Remain disabled.',
    })).resolves.toMatchObject({ id: 'browser-minimal' })
    await expect(ctx.shadowMind.remoteExportUpdate({
      id: 'browser-reviewer',
      name: 'Updated browser reviewer',
      enabled: false,
      debug: true,
      activationProbability: 0.6,
      activeForModels: [],
      runWithModel: 'mock/browser-shadow',
      reasoningEffort: 'high',
      timeoutSeconds: 8,
      tools: ['grep'],
      capture: 'since-compaction',
      context: 'minimal',
      thinkFirst: true,
      preFilters: ['tool-failure'],
      boostFilters: ['long-output'],
      boostFactor: 2,
      holdout: false,
      prompt: 'Review only actionable risks.',
    })).resolves.toMatchObject({
      name: 'Updated browser reviewer',
      enabled: false,
      runWithModel: 'mock/browser-shadow',
      reasoningEffort: 'high',
      timeoutSeconds: 8,
    })
    await expect(ctx.shadowMind.remoteExportUpdate({
      id: 'browser-reviewer',
      name: 'Cleared browser reviewer',
      enabled: false,
      debug: true,
      activationProbability: 0.6,
      activeForModels: [],
      runWithModel: null,
      reasoningEffort: null,
      timeoutSeconds: null,
      tools: ['grep'],
      capture: 'since-compaction',
      context: 'minimal',
      thinkFirst: true,
      preFilters: ['tool-failure'],
      boostFilters: ['long-output'],
      boostFactor: 2,
      holdout: false,
      prompt: 'Review only actionable risks.',
    })).resolves.toMatchObject({ name: 'Cleared browser reviewer' })
    await expect(ctx.shadowMind.remoteExportSetEnabled('browser-reviewer', true))
      .resolves.toMatchObject({ enabled: true })
    await expect(ctx.shadowMind.remoteExportDelete('browser-reviewer')).resolves.toBeUndefined()
    await expect(ctx.shadowMind.remoteExportDelete('browser-minimal')).resolves.toBeUndefined()
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
    await ctx.shadowMind.updateSettings({ valueLoopEnabled: false })
    expect(ctx.shadowMind.currentSettings().valueLoopEnabled).toBe(false)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    await ctx.shadowMind.updateSettings({ reasoningEffortLadder: [] })
    expect(runtime.nextReasoningEffort('low')).toBeUndefined()
    await ctx.shadowMind.updateSettings({ reasoningEffortLadder: ['low', 'high'] })
    expect(runtime.nextReasoningEffort(undefined)).toBe('low')
    expect(runtime.nextReasoningEffort('custom')).toBe('low')
    expect(runtime.nextReasoningEffort('low')).toBe('high')
    expect(runtime.nextReasoningEffort('high')).toBeUndefined()
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

  it('ignores durable events after runtime shutdown begins', async () => {
    const { ctx, root } = await setup([])
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    runtime.stopped = true

    appendManualToolTurn(root, 1)

    expect(ctx.shadowMind.status(root).totalRuns).toBe(0)
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
      verdict: 'challenge',
      refs: [],
    }
    const steer = vi.spyOn(root, 'steer').mockImplementation(() => undefined)
    vi.spyOn(root, 'status', 'get').mockReturnValue('running')

    await runtime.deliver(root, state, [{ ...report, epoch: state.epoch - 1 }])
    expect(steer).not.toHaveBeenCalled()
    await runtime.deliver(root, state, [report])
    expect(steer).toHaveBeenCalledOnce()

    runtime.stopped = true
    await runtime.deliver(root, state, [report])
    runtime.stopped = false
    await runtime.deliver({ id: root.id } as Agent, state, [report])
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

  it('redacts owner-side holdout literals from the child prompt, accepted report, and relay', async () => {
    const literal = 'HOLDOUT_SCORING_COMMAND'
    const starts: Parameters<SubagentProvider['start']>[0][] = []
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: (request) => {
        starts.push(request)
        return resultProvider({
          output: [],
          stopReason: 'completed',
          structured: {
            status: 'report',
            content: `Finding quoted ${literal} from the scoring output.`,
            verdict: 'challenge',
            severity: 0.8,
            refs: [],
          },
        }).start(request)
      },
    }
    const { ctx, dshHome, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      textResponse('ROOT_USED_REDACTED_REPORT'),
    ], { provider })
    await writeFile(join(dshHome, 'shadow-minds', 'holdout-keys.json'), JSON.stringify({
      reviewer: [literal],
    }))
    await ctx.shadowMind.updateDefinition('reviewer', { holdout: true })
    const relayed = Promise.withResolvers<SessionEvent<'user/message'>>()
    ctx.on('session/event', (session, event) => {
      if (session.id === root.id && event.type === 'user/message' && event.data.source.kind === 'shadow-report') {
        relayed.resolve(event)
      }
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: `Inspect ${literal} without disclosing it.` }],
      source: { kind: 'user' },
    }))
    await root.whenIdle()
    const relay = await relayed.promise
    await root.whenIdle()

    expect(starts).toHaveLength(1)
    expect(JSON.stringify(root.session.events)).toContain(literal)
    expect(JSON.stringify(starts[0]?.prompt)).not.toContain(literal)
    expect(JSON.stringify(starts[0]?.prompt)).toContain('[redacted holdout]')
    expect(JSON.stringify(relay.data.content)).not.toContain(literal)
    expect(JSON.stringify(relay.data.content)).toContain('[redacted holdout]')
    expect(JSON.stringify(relay.data.source)).not.toContain(literal)
    expect(relay.data.source).not.toHaveProperty('holdoutKeys')
    expect((relay.data.source as ShadowReportMessageSource).reports[0]).not.toHaveProperty('holdoutKeys')
  })

  it('replaces one conflicting pair with one bounded synthesis and durable replacement provenance', async () => {
    const starts: Parameters<SubagentProvider['start']>[0][] = []
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: (request) => {
        starts.push(request)
        const label = request.label
        const structured = label === 'shadow:reviewer'
          ? {
            status: 'report' as const,
            content: 'Challenge original report.',
            verdict: 'challenge' as const,
            severity: 0.9,
            refs: [],
          }
          : label === 'shadow:confirmer'
            ? {
              status: 'report' as const,
              content: 'Confirm original report.',
              verdict: 'confirm' as const,
              severity: 0.7,
              refs: [],
            }
            : {
              status: 'report' as const,
              content: 'Report A is better supported than Report B.',
              verdict: 'challenge' as const,
              severity: 1,
              refs: [],
            }
        return Promise.resolve({
          id: SessionId(`conflict-child-${String(starts.length)}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' as const, structured }),
          dispose: () => Promise.resolve(),
        })
      },
    }
    const { ctx, dshHome, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'fixture.txt' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      textResponse('ROOT_USED_SYNTHESIS'),
    ], {
      provider,
      config: { conflictSynthesisEnabled: true, resultBatchWindowMs: 20 },
    })
    await ctx.shadowMind.updateDefinition('reviewer', { debug: true })
    await ctx.shadowMind.createDefinition({
      id: 'confirmer',
      name: 'Confirm reviewer',
      enabled: true,
      debug: true,
      activationProbability: 1,
      activeForModels: [],
      runWithModel: 'mock/confirm-model',
      tools: [],
      prompt: 'Confirm only when the trajectory supports the current direction.',
    })
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 1,
      activeForModels: ['never/*'],
      runWithModel: 'mock/synthesis-model',
      tools: [],
      prompt: 'Choose the better-supported report and name it.',
    })
    const relayed = Promise.withResolvers<SessionEvent<'user/message'>>()
    ctx.on('session/event', (session, event) => {
      if (session.id === root.id && event.type === 'user/message' && event.data.source.kind === 'shadow-report') {
        relayed.resolve(event)
      }
    })

    root.followup(createUserMessage({
      content: [{ type: 'text', text: 'Exercise conflicting reviews.' }], source: { kind: 'user' },
    }))
    await root.whenIdle()
    const relay = await relayed.promise
    await root.whenIdle()

    expect(starts.map(request => request.label).filter(label => label === 'shadow:synthesizer')).toEqual([
      'shadow:synthesizer',
    ])
    const synthesisRequest = starts.find(request => request.label === 'shadow:synthesizer')
    expect(JSON.stringify(synthesisRequest?.prompt)).toContain('Challenge original report.')
    expect(JSON.stringify(synthesisRequest?.prompt)).toContain('Confirm original report.')
    expect(JSON.stringify(synthesisRequest?.prompt)).toContain('do not claim to have re-verified')
    const source = relay.data.source as ShadowReportMessageSource
    expect(source.reports).toHaveLength(1)
    expect(source.reports[0]).toMatchObject({
      shadowId: 'synthesizer',
      verdict: 'challenge',
      severity: 0.7,
    })
    expect(source.reports[0]?.replacesRunIds).toHaveLength(2)
    expect(JSON.stringify(relay.data.content)).toContain('Synthesis based on report text without re-verification.')
    expect(JSON.stringify(relay.data.content)).toContain('Report A is better supported than Report B.')
    expect(JSON.stringify(relay.data.content)).not.toContain('Challenge original report.')
    expect(JSON.stringify(relay.data.content)).not.toContain('Confirm original report.')
    const status = ctx.shadowMind.status(root)
    expect(status).toMatchObject({
      totalRuns: 3,
      synthesisRuns: 1,
      synthesisFailures: 0,
    })
    expect(status.recentReviews.some(review => review.shadowId === 'reviewer'
      && review.verdict === 'challenge')).toBe(true)
    expect(status.recentReviews.some(review => review.shadowId === 'confirmer'
      && review.verdict === 'confirm')).toBe(true)
    const replaced = source.reports[0]?.replacesRunIds ?? []
    const reviewerDebug = await readFile(join(dshHome, 'shadow-minds', 'logs', 'reviewer.jsonl'), 'utf8')
    const confirmerDebug = await readFile(join(dshHome, 'shadow-minds', 'logs', 'confirmer.jsonl'), 'utf8')
    expect(replaced.some(runId => reviewerDebug.includes(runId))).toBe(true)
    expect(replaced.some(runId => confirmerDebug.includes(runId))).toBe(true)
    const synthesisDebug = await readFile(join(dshHome, 'shadow-minds', 'logs', 'synthesizer.jsonl'), 'utf8')
    expect(synthesisDebug).toContain(JSON.stringify(replaced))
    expect(synthesisDebug).not.toContain('Challenge original report.')
    expect(synthesisDebug).not.toContain('Confirm original report.')
  })

  it('conditions a frugal holdout synthesis while preserving unrelated unscored reports', async () => {
    const starts: Parameters<SubagentProvider['start']>[0][] = []
    const base = resultProvider({
      output: [],
      stopReason: 'completed',
      structured: {
        status: 'report', content: 'The challenge is better supported.', verdict: 'challenge', refs: [],
      },
    })
    const provider: SubagentProvider = {
      ...base,
      start: (request) => {
        starts.push(request)
        return base.start(request)
      },
    }
    const { ctx, dshHome, root } = await setup([], {
      provider,
      config: {
        conflictSynthesisEnabled: true,
        sessionShadowSoftBudgetChars: 1,
        sessionShadowHardBudgetChars: 100_000,
        frugalShadowModel: 'deepseek/frugal-synthesizer',
      },
    })
    await writeFile(join(dshHome, 'shadow-minds', 'holdout-keys.json'), JSON.stringify({
      synthesizer: ['SYNTHESIS_OWNER_LITERAL'],
    }))
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 0,
      activeForModels: ['never/*'],
      tools: [],
      context: 'minimal',
      thinkFirst: true,
      holdout: true,
      prompt: 'Resolve the conflict without SYNTHESIS_OWNER_LITERAL.',
    })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    state.spentChars = 1
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reports = [
      acceptedReport(state.epoch, 'challenge-run', 'challenge'),
      acceptedReport(state.epoch, 'confirm-run', 'confirm'),
      acceptedReport(state.epoch, 'gap-run-a', 'gap'),
      acceptedReport(state.epoch, 'gap-run-b', 'gap'),
    ]

    await runtime.deliver(root, state, reports)

    expect(warned.mock.calls).toEqual([])
    expect(ctx.shadowMind.currentSettings().conflictSynthesisEnabled).toBe(true)
    expect(ctx.shadowMind.status(root)).toMatchObject({
      synthesisRuns: 1,
      synthesisFailures: 0,
    })
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      contextInheritance: 'none',
      thinkFirst: true,
      modelSelection: { provider: 'deepseek', model: 'frugal-synthesizer' },
    })
    expect(JSON.stringify(starts[0]?.prompt)).not.toContain('SYNTHESIS_OWNER_LITERAL')
    expect(followup).toHaveBeenCalledOnce()
    const message = followup.mock.calls[0]?.[0]
    expect(message?.source.kind).toBe('shadow-report')
    if (message?.source.kind !== 'shadow-report') throw new Error('expected a Shadow relay')
    expect(message.source.reports).toHaveLength(3)
    expect(message.source.reports.find(report => report.shadowId === 'synthesizer')).toMatchObject({
      severity: 0,
      replacesRunIds: ['challenge-run', 'confirm-run'],
    })
    expect(message.source.reports).not.toHaveProperty('holdoutKeys')
    await runtime.deliver(root, state, [
      acceptedReport(state.epoch, 'gap-only-a', 'gap'),
      acceptedReport(state.epoch, 'gap-only-b', 'gap'),
    ])
    expect(starts).toHaveLength(1)
    expect(followup).toHaveBeenCalledTimes(2)
    expect(ctx.shadowMind.status(root)).toMatchObject({
      budgetTier: 'frugal',
      synthesisRuns: 1,
      synthesisFailures: 0,
    })
  })

  it('fails synthesis open for incomplete, silent, not-relevant, and invalid structured results', async () => {
    const results: SubagentResult[] = [
      { output: [], stopReason: 'aborted' },
      { output: [], stopReason: 'completed', structured: { status: 'silent', content: '' } },
      { output: [], stopReason: 'completed', structured: { status: 'not_relevant', content: '' } },
      {
        output: [],
        stopReason: 'completed',
        structured: { status: 'report', content: 'Uncertain synthesis.', verdict: 'uncertain', refs: [] },
      },
    ]
    const starts: Parameters<SubagentProvider['start']>[0][] = []
    const provider: SubagentProvider = {
      ...resultProvider(results[0]!),
      start: (request) => {
        starts.push(request)
        const result = results[starts.length - 1]!
        return Promise.resolve({
          id: SessionId(`invalid-synthesis-${String(starts.length)}`),
          localAgent: undefined,
          result: Promise.resolve(result),
          dispose: () => Promise.resolve(),
        })
      },
    }
    const { ctx, dshHome, root } = await setup([], {
      provider,
      config: { conflictSynthesisEnabled: true },
    })
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 0,
      activeForModels: ['never/*'],
      tools: [],
      prompt: 'Choose one side.',
    })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    const reports = [
      acceptedReport(state.epoch, 'challenge-run', 'challenge', 0.8),
      acceptedReport(state.epoch, 'confirm-run', 'confirm', 0.7),
    ]

    for (let attempt = 1; attempt <= results.length; attempt += 1) {
      await runtime.deliver(root, state, reports)
      expect(followup).toHaveBeenCalledTimes(attempt)
      expect(JSON.stringify(followup.mock.calls[attempt - 1]?.[0])).toContain('challenge original report')
      expect(JSON.stringify(followup.mock.calls[attempt - 1]?.[0])).toContain('confirm original report')
    }

    expect(starts).toHaveLength(4)
    expect(ctx.shadowMind.status(root)).toMatchObject({
      totalRuns: 4,
      synthesisRuns: 4,
      synthesisFailures: 4,
      lastSynthesisFailure: 'invalid_result',
    })
    const debug = await readFile(join(dshHome, 'shadow-minds', 'logs', 'synthesizer.jsonl'), 'utf8')
    expect(debug.trim().split('\n')).toHaveLength(4)
    expect(debug).not.toContain('original report')
  })

  it('fails synthesis open across startup, result, disposal, and timeout failures', async () => {
    let attempt = 0
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: (request) => {
        attempt += 1
        if (attempt === 1) return Promise.reject(new Error('synthesis startup failed'))
        if (attempt === 2) {
          return Promise.resolve({
            id: SessionId('failed-synthesis-result'),
            localAgent: undefined,
            result: Promise.reject(new Error('synthesis result failed')),
            dispose: () => Promise.reject(new Error('synthesis disposal also failed')),
          })
        }
        if (attempt === 3) {
          return Promise.resolve({
            id: SessionId('failed-synthesis-disposal'),
            localAgent: undefined,
            result: Promise.resolve({
              output: [],
              stopReason: 'completed' as const,
              structured: {
                status: 'report', content: 'Would otherwise pass.', verdict: 'challenge', refs: [],
              },
            }),
            dispose: () => Promise.reject(new Error('synthesis disposal failed')),
          })
        }
        const result = new Promise<SubagentResult>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            const reason: unknown = request.signal.reason
            reject(reason instanceof Error ? reason : new Error('synthesis aborted', { cause: reason }))
          }, { once: true })
        })
        return Promise.resolve({
          id: SessionId('timed-synthesis'),
          localAgent: undefined,
          result,
          dispose: () => Promise.resolve(),
        })
      },
    }
    const { ctx, dshHome, root } = await setup([], {
      provider,
      config: { conflictSynthesisEnabled: true, conflictSynthesisTimeoutSeconds: 0.01 },
    })
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 0,
      activeForModels: ['never/*'],
      tools: [],
      prompt: 'Choose one side.',
    })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    const reports = [
      acceptedReport(state.epoch, 'challenge-run', 'challenge', 0.8),
      acceptedReport(state.epoch, 'confirm-run', 'confirm', 0.7),
    ]

    for (let index = 0; index < 4; index += 1) await runtime.deliver(root, state, reports)

    expect(followup).toHaveBeenCalledTimes(4)
    expect(ctx.shadowMind.status(root)).toMatchObject({
      totalRuns: 4,
      synthesisRuns: 4,
      synthesisFailures: 4,
      lastSynthesisFailure: 'run_failed',
    })
    const debug = await readFile(join(dshHome, 'shadow-minds', 'logs', 'synthesizer.jsonl'), 'utf8')
    expect(debug.trim().split('\n')).toHaveLength(4)
    expect(debug).not.toContain('original report')
  })

  it('fails synthesis open when its definition or prompt is unavailable and when the hard budget is exhausted', async () => {
    const { ctx, dshHome, root } = await setup([], {
      config: {
        conflictSynthesisEnabled: true,
        maxPromptChars: 1,
        sessionShadowHardBudgetChars: 1,
      },
    })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    const reports = [
      acceptedReport(state.epoch, 'challenge-run', 'challenge', 0.8),
      acceptedReport(state.epoch, 'confirm-run', 'confirm', 0.7),
    ]

    await runtime.deliver(root, state, reports)
    expect(ctx.shadowMind.status(root).lastSynthesisFailure).toBe('definition_unavailable')
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 0,
      activeForModels: ['never/*'],
      tools: [],
      prompt: 'Choose one side.',
    })
    await runtime.deliver(root, state, reports)
    expect(ctx.shadowMind.status(root).lastSynthesisFailure).toBe('prompt_invalid')
    state.spentChars = 1
    await runtime.deliver(root, state, reports)
    expect(ctx.shadowMind.status(root)).toMatchObject({
      synthesisRuns: 0,
      synthesisFailures: 3,
      lastSynthesisFailure: 'budget_exhausted',
      budgetTier: 'exhausted',
    })
    expect(followup).toHaveBeenCalledTimes(3)
    const debug = await readFile(join(dshHome, 'shadow-minds', 'logs', 'synthesizer.jsonl'), 'utf8')
    expect(debug).toContain('definition_unavailable')
    expect(debug).toContain('prompt_invalid')
    expect(debug).toContain('budget_exhausted')
    expect(debug).not.toContain('original report')
  })

  it('fails synthesis open for an oversized synthesized report', async () => {
    const { ctx, root } = await setup([], {
      provider: resultProvider({
        output: [],
        stopReason: 'completed',
        structured: { status: 'report', content: 'oversized synthesis', verdict: 'challenge', refs: [] },
      }),
      config: { conflictSynthesisEnabled: true, maxReportChars: 3 },
    })
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 0,
      activeForModels: ['never/*'],
      tools: [],
      prompt: 'Choose one side.',
    })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)

    await runtime.deliver(root, state, [
      acceptedReport(state.epoch, 'challenge-run', 'challenge', 0.8),
      acceptedReport(state.epoch, 'confirm-run', 'confirm', 0.7),
    ])

    expect(followup).toHaveBeenCalledOnce()
    expect(ctx.shadowMind.status(root)).toMatchObject({
      synthesisRuns: 1,
      synthesisFailures: 1,
      lastSynthesisFailure: 'invalid_report',
    })
  })

  it('contains synthesis diagnostic write failures', async () => {
    const { ctx, root } = await setup([], { config: { conflictSynthesisEnabled: true } })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    vi.spyOn(ctx.shadowMind.registry, 'appendDebug').mockRejectedValue(new Error('debug unavailable'))
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)

    await runtime.deliver(root, state, [
      acceptedReport(state.epoch, 'challenge-run', 'challenge', 0.8),
      acceptedReport(state.epoch, 'confirm-run', 'confirm', 0.7),
    ])

    expect(warned).toHaveBeenCalledWith(
      'dsh-shadow-mind: failed to write synthesis debug log: %o',
      expect.any(Error),
    )
    expect(ctx.shadowMind.status(root).lastSynthesisFailure).toBe('definition_unavailable')
  })

  it('rejects a relay that still contains an owner holdout literal', async () => {
    const { ctx, root } = await setup([])
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const report: AcceptedShadowReport = {
      ...acceptedReport(state.epoch, 'unsafe-run', 'gap'),
      content: 'OWNER_LITERAL survived',
      holdoutKeys: ['OWNER_LITERAL'],
    }

    await expect(runtime.deliver(root, state, [report])).rejects.toThrow('retained a holdout literal')
  })

  it('cancels synthesis without relaying an empty or stale batch', async () => {
    const synthesis = Promise.withResolvers<SubagentResult>()
    const started = Promise.withResolvers<undefined>()
    const provider: SubagentProvider = {
      ...resultProvider({ output: [], stopReason: 'completed' }),
      start: () => {
        started.resolve(undefined)
        return Promise.resolve({
          id: SessionId('stale-synthesis-child'),
          localAgent: undefined,
          result: synthesis.promise,
          dispose: () => Promise.resolve(),
        })
      },
    }
    const { ctx, root } = await setup([], {
      provider,
      config: { conflictSynthesisEnabled: true },
    })
    await ctx.shadowMind.createDefinition({
      id: 'synthesizer',
      name: 'Conflict synthesizer',
      enabled: true,
      debug: false,
      activationProbability: 0,
      activeForModels: ['never/*'],
      tools: [],
      prompt: 'Choose one side.',
    })
    ctx.shadowMind.resume(root)
    const runtime = ctx.shadowMind as unknown as RuntimeProbe
    const state = runtime.owners.get(root)!
    const followup = vi.spyOn(root, 'followup').mockImplementation(() => undefined)
    const delivery = runtime.deliver(root, state, [
      acceptedReport(state.epoch, 'challenge-run', 'challenge', 0.8),
      acceptedReport(state.epoch, 'confirm-run', 'confirm', 0.7),
    ])
    await started.promise
    ctx.shadowMind.pause(root)
    synthesis.resolve({
      output: [],
      stopReason: 'completed',
      structured: {
        status: 'report', content: 'Stale synthesis.', verdict: 'challenge', refs: [],
      },
    })
    await delivery

    expect(followup).not.toHaveBeenCalled()
    expect(ctx.shadowMind.status(root)).toMatchObject({ paused: true, synthesisRuns: 1 })
  })

  it('relays one structured fresh-child report with durable provenance', async () => {
    const { ctx, adapter, root } = await setup([
      toolCallResponse('read-root', 'read', { path: 'ROOT_ARGUMENT_SECRET' }),
      textResponse('ROOT_TOOL_TURN_DONE'),
      toolCallResponse('shadow-report', STRUCTURED_OUTPUT_TOOL, {
        status: 'report',
        content: 'SHADOW_ACTIONABLE_FINDING',
        verdict: 'challenge',
        refs: [],
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
    expect(ctx.shadowMind.status(root)).toMatchObject({
      totalRuns: 1,
      lastRun: {
        shadowId: 'reviewer',
        childSessionId: firstReport?.childSessionId,
        outcome: 'report',
      },
    })
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
