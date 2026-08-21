import { PassThrough, Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as commandReviewer from '../src/index.ts'

const SESSION_ID = SessionId('command-reviewer')

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function reviewJson(text = 'Review text.'): string {
  return [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'reason-1', type: 'reasoning' } },
    { type: 'item.completed', item: { id: 'reason-1', type: 'reasoning', text: 'private summary' } },
    { type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'git diff --check' } },
    { type: 'item.completed', item: { id: 'command-1', type: 'command_execution', command: 'git diff --check' } },
    { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text } },
    { type: 'turn.completed' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
}

class StubSubprocess extends SubprocessRuntime {
  spawns: SubprocessSpawnSpec[] = []
  handles: SubprocessHandle[] = []
  terminations: Array<ReturnType<typeof vi.fn>> = []
  resolveError: Error | undefined
  spawnError: unknown
  nextOutcome: SubprocessOutcome = { exitCode: 0, signal: null }
  nextStdout = reviewJson()
  nextStderr = ''
  stdoutMode: 'stream' | 'collected' | 'missing' = 'stream'
  nextChunks: Array<string | Buffer | Uint8Array> | undefined
  collectStderr = true
  terminateStreamError = false
  terminateDoneError: Error | undefined
  terminateError: Error | undefined
  terminateOutcome: SubprocessOutcome = { exitCode: null, signal: 'SIGTERM' }
  manual = false
  manualWait = false
  waitError: Error | undefined
  waitResult = true
  resolveGate: Promise<undefined> | undefined
  afterResolve: (() => void) | undefined
  beforeSpawn: (() => void) | undefined
  onSpawn: (() => void) | undefined
  lookups: string[] = []
  liveStream: PassThrough | undefined
  liveDone: PromiseWithResolvers<SubprocessOutcome> | undefined
  waitGates: Array<PromiseWithResolvers<boolean>> = []
  waits: Array<ReturnType<typeof vi.fn>> = []
  resolvedExecutable = '/resolved/codex'

  override async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    this.lookups.push(command)
    if (this.resolveGate !== undefined) await this.resolveGate
    signal?.throwIfAborted()
    if (this.resolveError !== undefined) throw this.resolveError
    this.afterResolve?.()
    return command === 'cmd.exe' ? '/resolved/cmd.exe' : this.resolvedExecutable
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    this.beforeSpawn?.()
    if (this.spawnError !== undefined) throw this.spawnError
    const done = Promise.withResolvers<SubprocessOutcome>()
    const stream = this.manual ? new PassThrough() : Readable.from(this.nextChunks ?? [this.nextStdout])
    if (this.manual) {
      this.liveStream = stream as PassThrough
      this.liveDone = done
    } else {
      done.resolve(this.nextOutcome)
    }
    let stopped = false
    const terminate = vi.fn(() => {
      if (this.terminateError !== undefined) throw this.terminateError
      if (stopped) return
      stopped = true
      if (this.manual) {
        if (this.terminateStreamError) (stream as PassThrough).destroy(new Error('terminated stream'))
        else (stream as PassThrough).end()
      }
      if (this.terminateDoneError === undefined) done.resolve(this.terminateOutcome)
      else done.reject(this.terminateDoneError)
    })
    const waitGate = this.manualWait ? Promise.withResolvers<boolean>() : undefined
    if (waitGate !== undefined) this.waitGates.push(waitGate)
    const waitForExit = vi.fn(() => this.waitError === undefined
      ? waitGate?.promise ?? Promise.resolve(this.waitResult)
      : Promise.reject(this.waitError))
    this.terminations.push(terminate)
    this.waits.push(waitForExit)
    spec.signal?.addEventListener('abort', terminate, { once: true })
    const handle: SubprocessHandle = {
      pid: 42,
      stdin: undefined,
      stdout: this.stdoutMode === 'stream' ? stream : undefined,
      stderr: undefined,
      collected: {
        ...this.stdoutMode === 'collected'
          ? { stdout: { readFrom: () => ({ text: this.nextStdout, nextOffset: this.nextStdout.length, lossy: false }) } }
          : {},
        ...this.collectStderr
          ? { stderr: { readFrom: () => ({ text: this.nextStderr, nextOffset: this.nextStderr.length, lossy: false }) } }
          : {},
      },
      done: done.promise,
      terminate,
      waitForExit,
    }
    this.handles.push(handle)
    this.onSpawn?.()
    return handle
  }

  complete(text = reviewJson(), outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void {
    this.liveStream?.end(text)
    this.liveDone?.resolve(outcome)
  }

  override spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('command-reviewer never allocates a terminal')
  }
}

interface Harness {
  readonly ctx: Context
  readonly subprocess: StubSubprocess
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

const contexts = new Set<Context>()
const persistenceRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...contexts].map(async (ctx) => { await ctx.fiber.dispose() }))
  contexts.clear()
  await Promise.all([...persistenceRoots].map(root => rm(root, { recursive: true, force: true })))
  persistenceRoots.clear()
})

async function runtimeContext(settings: boolean): Promise<Context> {
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-command-reviewer-'))
  persistenceRoots.add(persistenceRoot)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: persistenceRoot,
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(CommandRuntime)
  if (settings) await ctx.plugin(MemorySettings)
  await ctx.plugin(StubSubprocess)
  return ctx
}

async function harness(options: {
  config?: commandReviewer.Config
  settings?: boolean
  cwd?: string
} = {}): Promise<Harness> {
  const ctx = await runtimeContext(options.settings === true)
  const subprocess = ctx.subprocess as unknown as StubSubprocess
  const plugin = ctx.plugin(commandReviewer, options.config ?? {})
  await plugin.await()
  const session = ctx.sessions.create(SESSION_ID, options.cwd === undefined
    ? undefined
    : { meta: { cwd: options.cwd } })
  const agent = { id: SESSION_ID, session, ctx, status: 'idle', options: {} } as unknown as Agent
  return { ctx, subprocess, agent, plugin }
}

function seed(test: Harness): void {
  test.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  test.agent.session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
}

async function run(test: Harness, suffix = '', controller = new AbortController()) {
  const execution = await test.ctx.commands.execute(test.agent, `/review${suffix}`, [], controller.signal)
  if (execution === undefined) throw new Error('review command was not registered')
  return execution
}

function rejectReviewEnd(test: Harness, failure: unknown): void {
  const session = test.agent.session
  const append = session.append.bind(session)
  const failingAppend: Session['append'] = (type, data, ...opts) => {
    if (type === 'review/end') throw failure
    return append(type, data, ...opts)
  }
  Object.defineProperty(session, 'append', { configurable: true, value: failingAppend })
}

async function reviewEnd(test: Harness) {
  await vi.waitFor(() => {
    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(true)
  })
  const event = test.agent.session.events.findLast(candidate => candidate.type === 'review/end')
  if (event?.type !== 'review/end') throw new Error('review/end missing')
  return event
}

describe('@deepseek-ai/dsh-command-reviewer registration', () => {
  it('registers a Loader-safe command and disposes it', async () => {
    const test = await harness()
    expect(commandReviewer.inject).toEqual(['commands', 'sessions', 'sessionPersistence', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandReviewer)).toBe(commandReviewer)
    expect(test.ctx.commands.find(test.agent, 'review')).toMatchObject({ recordInput: false })
    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'review')).toBeUndefined()
  })

  it('rejects a termination grace outside the Node timer range', async () => {
    const ctx = await runtimeContext(false)
    await expect(ctx.plugin(commandReviewer, { terminateGraceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`command-reviewer: terminateGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  })

  it('rejects a review timeout outside the Node timer range', async () => {
    const ctx = await runtimeContext(false)
    await expect(ctx.plugin(commandReviewer, { timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`command-reviewer: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  })
})

describe('/review durable background lifecycle', () => {
  it('settles both lifecycles when an admitted persisted review resumes before command acknowledgment', async () => {
    const test = await harness()
    const commandId = CommandId('review-from-stopped-host')
    test.agent.session.append('command/run', {
      commandId, name: 'review', args: ' inspect recovery', source: { kind: 'user' },
    })
    const start = test.agent.session.append('review/start', {
      commandId,
      focus: 'inspect recovery',
      request: {
        prompt: 'review prior work', argv: ['/resolved/codex', 'exec'], cwd: process.cwd(),
        hostDeath: 'terminate', timeoutMs: 1_800_000,
      },
    })
    agentEvents(test.ctx, test.agent).emit('agent/session-start', { source: 'resume' })
    agentEvents(test.ctx, test.agent).emit('agent/session-start', { source: 'resume' })

    expect(test.agent.session.events.filter(event => event.type === 'command/done')).toMatchObject([{
      data: { commandId, kind: 'success', sourceEventSeq: start.seq },
    }])
    expect(test.agent.session.events.filter(event => event.type === 'review/end')).toMatchObject([{
      data: {
        commandId,
        outcome: 'interrupted',
        text: 'Review interrupted because its previous host stopped before recording completion.',
      },
    }])

    const acknowledgedId = CommandId('review-acknowledged-before-stop')
    test.agent.session.append('command/run', {
      commandId: acknowledgedId, name: 'review', args: ' acknowledged', source: { kind: 'user' },
    })
    const acknowledgedStart = test.agent.session.append('review/start', {
      commandId: acknowledgedId,
      focus: 'acknowledged',
      request: {
        prompt: 'review acknowledged work', argv: ['/resolved/codex', 'exec'], cwd: process.cwd(),
        hostDeath: 'terminate', timeoutMs: 1_800_000,
      },
    })
    test.agent.session.append('command/done', {
      commandId: acknowledgedId, kind: 'success', sourceEventSeq: acknowledgedStart.seq,
    })

    agentEvents(test.ctx, test.agent).emit('agent/session-start', { source: 'resume' })

    expect(test.agent.session.events.filter(event => (
      event.type === 'command/done' && event.data.commandId === acknowledgedId
    ))).toHaveLength(1)
    expect(test.agent.session.events.filter(event => (
      event.type === 'review/end' && event.data.commandId === acknowledgedId
    ))).toHaveLength(1)
  })

  it('restores a missing command acknowledgement after the review already ended', async () => {
    const test = await harness()
    const commandId = CommandId('review-ended-before-acknowledgement')
    test.agent.session.append('command/run', {
      commandId, name: 'review', source: { kind: 'user' },
    })
    const start = test.agent.session.append('review/start', {
      commandId,
      focus: 'inspect the completed review',
      request: {
        prompt: 'review prior work', argv: ['/resolved/codex', 'exec'], cwd: process.cwd(),
        hostDeath: 'terminate', timeoutMs: 1_800_000,
      },
    })
    test.agent.session.append('review/end', {
      commandId, outcome: 'completed', text: 'No findings.',
    })

    agentEvents(test.ctx, test.agent).emit('agent/session-start', { source: 'resume' })
    agentEvents(test.ctx, test.agent).emit('agent/session-start', { source: 'resume' })

    expect(test.agent.session.events.filter(event => (
      event.type === 'command/done' && event.data.commandId === commandId
    ))).toMatchObject([{
      data: { commandId, kind: 'success', sourceEventSeq: start.seq },
    }])
    expect(test.agent.session.events.filter(event => (
      event.type === 'review/end' && event.data.commandId === commandId
    ))).toMatchObject([{
      data: { commandId, outcome: 'completed', text: 'No findings.' },
    }])
  })

  it('closes an inherited open review in a fork without changing or blaming the source session', async () => {
    const test = await harness()
    const commandId = CommandId('review-active-during-fork')
    test.agent.session.append('command/run', {
      commandId, name: 'review', args: ' inspect fork', source: { kind: 'user' },
    })
    test.agent.session.append('review/start', {
      commandId,
      focus: 'inspect fork',
      request: {
        prompt: 'review source work', argv: ['/resolved/codex', 'exec'], cwd: process.cwd(),
        hostDeath: 'terminate', timeoutMs: 1_800_000,
      },
    })
    const seed = test.agent.session.events
    const childSession = test.ctx.sessions.create(SessionId('command-reviewer-fork'), {
      seed,
      meta: {
        parentSession: test.agent.session.id,
        seedLength: seed.length,
      },
    })
    const child = {
      id: childSession.id, session: childSession, ctx: test.ctx, status: 'idle', options: {},
    } as unknown as Agent

    agentEvents(test.ctx, child).emit('agent/session-start', { source: 'startup' })

    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)
    expect(childSession.events.findLast(event => event.type === 'review/end')?.data).toEqual({
      commandId,
      outcome: 'interrupted',
      text: 'Review was not continued in this fork; the source session review is unaffected.',
    })
  })

  it('returns after starting instead of waiting for Codex', async () => {
    const test = await harness({ cwd: 'C:\\work\\repo' })
    seed(test)
    test.subprocess.manual = true

    const execution = await run(test, ' 审查上面的方案和代码修改')
    const start = test.agent.session.events.find(event => event.type === 'review/start')
    expect(execution.result).toEqual({ kind: 'success', sourceEventSeq: start?.seq })
    expect(test.subprocess.spawns).toHaveLength(1)
    expect(test.agent.session.events.some(event => event.type === 'command/done')).toBe(true)
    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)

    const [spec] = test.subprocess.spawns
    expect(spec?.argv).toContain('--json')
    expect(spec?.argv[0]).toBe('/resolved/codex')
    expect(spec?.cwd).toBe('C:\\work\\repo')
    expect(spec?.stdio.stdout).toBe('pipe')
    expect(spec?.hostDeath).toBe('terminate')
    expect(spec?.signal).toBeInstanceOf(AbortSignal)
    if (typeof spec?.stdio.stdin !== 'object') throw new Error('expected batch stdin')
    expect(spec.stdio.stdin.data).toContain('Reviewer focus for this run:\n审查上面的方案和代码修改')
    expect(spec.stdio.stdin.data).toContain('untrusted conversation evidence')
    const boundary = spec.stdio.stdin.data.match(/<untrusted-transcript-([0-9a-f-]{36})>/)?.[1]
    expect(boundary).toBeDefined()
    expect(spec.stdio.stdin.data).toContain(`</untrusted-transcript-${boundary}>`)
    if (start?.type !== 'review/start') throw new Error('review/start missing')
    expect(start.data.request).toEqual({
      prompt: spec.stdio.stdin.data,
      argv: spec.argv,
      cwd: spec.cwd,
      hostDeath: 'terminate',
      timeoutMs: 3_600_000,
    })

    test.subprocess.complete()
    expect((await reviewEnd(test)).data).toEqual({
      commandId: execution.commandId, outcome: 'completed', text: 'Review text.',
    })
  })

  it('does not spawn until review/start reaches the session durability checkpoint', async () => {
    const test = await harness()
    seed(test)
    const gate = Promise.withResolvers<undefined>()
    let flushes = 0
    test.ctx.on('session/flush', async () => {
      flushes += 1
      if (flushes === 1) await gate.promise
    })

    const execution = run(test)
    await vi.waitFor(() => {
      expect(test.agent.session.events.some(event => event.type === 'review/start')).toBe(true)
    })
    expect(test.subprocess.spawns).toEqual([])

    gate.resolve(undefined)
    await execution
    expect(test.subprocess.spawns).toHaveLength(1)
  })

  it('does not spawn when review/start persistence fails and records the failed admission', async () => {
    const test = await harness()
    seed(test)
    let flushes = 0
    test.ctx.on('session/flush', () => {
      flushes += 1
      if (flushes === 1) throw new Error('storage unavailable')
    })

    const execution = await run(test)

    expect(execution.result.kind).toBe('success')
    expect(test.subprocess.spawns).toEqual([])
    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'failed',
      text: 'The review could not persist its start: storage unavailable',
    })
    expect(flushes).toBe(2)
  })

  it('does not treat a successful flush as durable when reread omits review/start', async () => {
    const test = await harness()
    seed(test)
    const readFrom = test.ctx.sessionPersistence.readFrom.bind(test.ctx.sessionPersistence)
    let reads = 0
    vi.spyOn(test.ctx.sessionPersistence, 'readFrom').mockImplementation(async (id, fromSeq, signal) => {
      const durable = await readFrom(id, fromSeq, signal)
      reads += 1
      return reads === 1 ? { ...durable, events: [] } : durable
    })

    const execution = await run(test)

    expect(execution.result.kind).toBe('success')
    expect(test.subprocess.spawns).toEqual([])
    const end = await reviewEnd(test)
    expect(end.data.outcome).toBe('failed')
    expect(end.data.text).toContain('durable session log does not contain review/start seq')
    expect(reads).toBe(2)
  })

  it('retains admission when durable reads cannot verify either lifecycle record', async () => {
    const test = await harness()
    seed(test)
    vi.spyOn(test.ctx.sessionPersistence, 'readFrom').mockRejectedValue(new Error('storage read unavailable'))
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    const execution = await run(test)

    expect(execution.result.kind).toBe('success')
    expect(test.subprocess.spawns).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'review/start durability and terminal publication failed',
    ))
    const retry = (await run(test)).result
    expect(retry.kind).toBe('error')
    expect(retry.text).toContain('1 active review')
  })

  it('publishes cancellation without spawning when owner teardown occurs during start persistence', async () => {
    const test = await harness()
    seed(test)
    const gate = Promise.withResolvers<undefined>()
    let flushes = 0
    test.ctx.on('session/flush', async () => {
      flushes += 1
      if (flushes === 1) await gate.promise
    })

    const execution = run(test)
    await vi.waitFor(() => {
      expect(test.agent.session.events.some(event => event.type === 'review/start')).toBe(true)
    })
    const disposal = test.plugin.dispose()
    gate.resolve(undefined)

    expect((await execution).result.kind).toBe('success')
    await disposal
    expect(test.subprocess.spawns).toEqual([])
    expect((await reviewEnd(test)).data.outcome).toBe('cancelled')
  })

  it('reports cancellation publication failure during start-persistence teardown', async () => {
    const test = await harness()
    seed(test)
    const gate = Promise.withResolvers<undefined>()
    let flushes = 0
    test.ctx.on('session/flush', async () => {
      flushes += 1
      if (flushes === 1) await gate.promise
      if (flushes === 2) throw new Error('cancel storage unavailable')
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    const execution = run(test)
    await vi.waitFor(() => {
      expect(test.agent.session.events.some(event => event.type === 'review/start')).toBe(true)
    })
    const disposal = test.plugin.dispose()
    gate.resolve(undefined)

    expect((await execution).result.kind).toBe('success')
    await disposal
    expect(test.subprocess.spawns).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel storage unavailable'))
  })

  it('does not send request-configuration context to Codex as user dialogue', async () => {
    const test = await harness()
    seed(test)
    for (const [text, source] of [
      ['workspace rules', { kind: 'plugin', plugin: 'instructions', form: 'instructions' }],
      ['available skills', { kind: 'plugin', plugin: 'skills', form: 'catalog' }],
      ['runtime policy', { kind: 'plugin', plugin: 'runtime', form: 'snapshot', sections: [] }],
    ] as const) {
      test.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }], source,
      }), { surfaceOp: 'append' })
    }

    await run(test)

    const stdin = test.subprocess.spawns[0]?.stdio.stdin
    if (typeof stdin !== 'object') throw new Error('expected batch stdin')
    expect(stdin.data).toContain('User: fix the bug')
    expect(stdin.data).toContain('Agent: done')
    expect(stdin.data).not.toContain('workspace rules')
    expect(stdin.data).not.toContain('available skills')
    expect(stdin.data).not.toContain('runtime policy')
  })

  it('keeps running after the browser invocation signal aborts', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    const browser = new AbortController()
    const execution = await run(test, '', browser)
    const [spec] = test.subprocess.spawns
    browser.abort(new Error('browser disconnected'))
    expect(spec?.signal?.aborted).toBe(false)
    expect(test.subprocess.terminations[0]).not.toHaveBeenCalled()

    test.subprocess.complete(reviewJson('Still completed.'))
    expect((await reviewEnd(test)).data).toMatchObject({
      commandId: execution.commandId, outcome: 'completed', text: 'Still completed.',
    })
  })

  it('settles the command from the admitted review when the browser aborts inside spawn', async () => {
    const test = await harness()
    seed(test)
    const browser = new AbortController()
    test.subprocess.onSpawn = () => { browser.abort(new Error('browser disconnected during spawn')) }

    const execution = await run(test, '', browser)

    const start = test.agent.session.events.find(event => event.type === 'review/start')
    expect(execution.result).toEqual({ kind: 'success', sourceEventSeq: start?.seq })
    expect(test.agent.session.events.filter(event => event.type === 'command/done')).toMatchObject([{
      data: { commandId: execution.commandId, kind: 'success', sourceEventSeq: start?.seq },
    }])
    expect((await reviewEnd(test)).data).toMatchObject({
      commandId: execution.commandId, outcome: 'completed', text: 'Review text.',
    })
  })

  it('owns and drains a process when teardown reenters through subprocess spawn', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.manualWait = true
    let disposal: Promise<void> | undefined
    let disposed = false
    test.subprocess.onSpawn = () => {
      const pending = test.plugin.dispose()
      disposal = pending
      void pending.then(() => { disposed = true })
    }

    const execution = await run(test)
    await vi.waitFor(() => { expect(test.subprocess.waits[0]).toHaveBeenCalledOnce() })

    expect(execution.result.kind).toBe('success')
    expect(disposed).toBe(false)
    expect(test.subprocess.spawns).toHaveLength(1)
    expect(test.subprocess.terminations[0]).toHaveBeenCalledOnce()
    test.subprocess.waitGates[0]?.resolve(true)
    await disposal
    expect(disposed).toBe(true)
    expect((await reviewEnd(test)).data).toMatchObject({ outcome: 'cancelled' })
  })

  it('records real item progress and final text without model-visible messages', async () => {
    const test = await harness()
    seed(test)
    const before = test.agent.session.deriveMessages()
    const execution = await run(test)
    const end = await reviewEnd(test)
    const reviewEvents = test.agent.session.events.filter(event => event.type.startsWith('review/'))
    expect(reviewEvents.map(event => event.type)).toEqual([
      'review/start', 'review/activity', 'review/activity', 'review/activity',
      'review/activity', 'review/activity', 'review/activity', 'review/activity', 'review/end',
    ])
    expect(reviewEvents.filter(event => event.type === 'review/activity').map(event => event.data)).toContainEqual({
      commandId: execution.commandId,
      activityId: 'command-1', kind: 'command', status: 'started', detail: 'git diff --check',
    })
    expect(end.data.text).toBe('Review text.')
    expect(test.agent.session.deriveMessages()).toEqual(before)
  })

  it('records a JSONL error as a visible failed review', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = `${JSON.stringify({ type: 'turn.failed', error: { message: 'authentication failed' } })}\n`
    await run(test)
    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'failed', text: 'The review failed: Codex reported: authentication failed',
    })
  })

  it('reports a structured Codex failure together with its nonzero exit', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = `${JSON.stringify({ type: 'turn.failed', error: { message: 'authentication failed' } })}\n`
    test.subprocess.nextOutcome = { exitCode: 1, signal: null }

    await run(test)

    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'failed',
      text: [
        'The review failed:',
        '- Codex reported: authentication failed',
        '- Codex exited with code 1.',
      ].join('\n'),
    })
  })

  it('preserves final review text when Codex reports an error and exits nonzero', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = `${reviewJson('Useful review findings.')}${JSON.stringify({
      type: 'error', message: 'stream closed after the final message',
    })}\n`
    test.subprocess.nextOutcome = { exitCode: 7, signal: null }

    const execution = await run(test)

    expect((await reviewEnd(test)).data).toEqual({
      commandId: execution.commandId,
      outcome: 'failed',
      text: [
        'Useful review findings.',
        '',
        'The review produced output but did not finish cleanly:',
        '- Codex reported: stream closed after the final message',
        '- Codex exited with code 7.',
      ].join('\n'),
    })
  })

  it('reports every structured Codex failure in arrival order', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = [
      { type: 'error', message: 'network disconnected' },
      { type: 'turn.failed', error: { message: 'request failed' } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n'

    await run(test)

    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'failed',
      text: [
        'The review failed:',
        '- Codex reported: network disconnected',
        '- Codex reported: request failed',
      ].join('\n'),
    })
  })

  it('combines malformed JSONL with a successful nonzero process outcome', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = [
      JSON.stringify({ type: 'error', message: 'request already failed' }),
      '{bad}',
    ].join('\n') + '\n'
    test.subprocess.nextOutcome = { exitCode: 2, signal: null }

    await run(test)

    const text = (await reviewEnd(test)).data.text
    expect(text).toContain('Codex reported: request already failed')
    expect(text).toContain('Codex output failed: invalid JSON')
    expect(text).toContain('Codex exited with code 2.')
  })

  it('preserves final review text decoded before malformed JSONL', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = `${reviewJson('Useful partial findings.')}{bad}\n`

    await run(test)

    const end = await reviewEnd(test)
    expect(end.data.outcome).toBe('failed')
    expect(end.data.text).toContain('Useful partial findings.')
    expect(end.data.text).toContain('The review produced output but did not finish cleanly:')
    expect(end.data.text).toContain('Codex output failed: invalid JSON')
  })

  it('combines output overflow with signal termination', async () => {
    const test = await harness({ config: { maxOutputBytes: 8 } })
    seed(test)
    test.subprocess.nextOutcome = { exitCode: null, signal: 'SIGKILL' }

    await run(test)

    const text = (await reviewEnd(test)).data.text
    expect(text).toContain('Codex JSONL output exceeded configured limit of 8 bytes')
    expect(text).toContain('Codex was terminated by SIGKILL.')
  })

  it('records malformed JSONL, missing output, nonzero exit, and output overflow as failures', async () => {
    const cases: Array<{ stdout: string; outcome?: SubprocessOutcome; config?: commandReviewer.Config; text: string }> = [
      { stdout: '{bad}\n', text: 'invalid JSON' },
      { stdout: `${JSON.stringify({ type: 'turn.completed' })}\n`, text: 'without producing review output' },
      { stdout: reviewJson(), outcome: { exitCode: 2, signal: null }, text: 'exited with code 2' },
      { stdout: reviewJson(), config: { maxOutputBytes: 8 }, text: 'exceeded configured limit of 8 bytes' },
    ]
    for (const item of cases) {
      const test = await harness(item.config === undefined ? {} : { config: item.config })
      seed(test)
      test.subprocess.nextStdout = item.stdout
      test.subprocess.nextOutcome = item.outcome ?? { exitCode: 0, signal: null }
      await run(test)
      const end = await reviewEnd(test)
      expect(end.data.outcome).toBe('failed')
      expect(end.data.text).toContain(item.text)
    }
  })

  it('accepts repository inspection output above 64 KiB with the default cap', async () => {
    const test = await harness()
    seed(test)
    const command = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'large-command',
        type: 'command_execution',
        command: 'git diff',
        aggregated_output: 'x'.repeat(70_000),
      },
    })
    test.subprocess.nextStdout = `${command}\n${reviewJson('Large review completed.')}`

    await run(test)

    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'completed', text: 'Large review completed.',
    })
  })

  it('accepts collected stdout without a final newline and enforces its byte cap', async () => {
    const success = await harness()
    seed(success)
    success.subprocess.stdoutMode = 'collected'
    success.subprocess.nextStdout = reviewJson('Collected.').trimEnd()
    await run(success)
    expect((await reviewEnd(success)).data).toMatchObject({ outcome: 'completed', text: 'Collected.' })

    const overflow = await harness({ config: { maxOutputBytes: 8 } })
    seed(overflow)
    overflow.subprocess.stdoutMode = 'collected'
    await run(overflow)
    expect((await reviewEnd(overflow)).data.text).toContain('exceeded configured limit of 8 bytes')
  })

  it('reports an unavailable stdout pipe and a non-byte stream chunk', async () => {
    const missing = await harness()
    seed(missing)
    missing.subprocess.stdoutMode = 'missing'
    await run(missing)
    expect((await reviewEnd(missing)).data.text).toContain('stdout pipe is unavailable')

    const invalid = await harness()
    seed(invalid)
    invalid.subprocess.nextChunks = [1 as never]
    await run(invalid)
    expect((await reviewEnd(invalid)).data.text).toContain('non-byte chunk')

    const termination = await harness()
    seed(termination)
    termination.subprocess.manual = true
    termination.subprocess.terminateError = new Error('termination request failed')
    await run(termination)
    termination.subprocess.liveStream?.end('{bad}\n')
    await vi.waitFor(() => { expect(termination.subprocess.terminations[0]).toHaveBeenCalledOnce() })
    termination.subprocess.liveDone?.resolve({ exitCode: 2, signal: null })
    const terminationText = (await reviewEnd(termination)).data.text
    expect(terminationText).toContain('Codex output failed: invalid JSON')
    expect(terminationText).toContain('Codex exited with code 2.')
    expect(terminationText).toContain('Codex termination request failed: termination request failed')
  })

  it('decodes Buffer and Uint8Array chunks and ignores blank JSONL lines', async () => {
    const test = await harness()
    seed(test)
    const output = `\n${reviewJson('Chunked.').trimEnd()}`
    const split = Math.floor(output.length / 2)
    test.subprocess.nextChunks = [
      Buffer.from(output.slice(0, split)),
      new Uint8Array(Buffer.from(output.slice(split))),
    ]
    await run(test)
    expect((await reviewEnd(test)).data).toMatchObject({ outcome: 'completed', text: 'Chunked.' })
  })

  it('records a final-line failure without a trailing newline', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = JSON.stringify({ type: 'error', message: 'last-line failure' })
    await run(test)
    expect((await reviewEnd(test)).data.text).toBe('The review failed: Codex reported: last-line failure')
  })

  it('reports signal termination with absent, empty, and truncated stderr', async () => {
    for (const stderr of [undefined, '', 'short', 'x'.repeat(500)] as const) {
      const test = await harness()
      seed(test)
      test.subprocess.nextOutcome = { exitCode: null, signal: 'SIGKILL' }
      if (stderr === undefined) test.subprocess.collectStderr = false
      else test.subprocess.nextStderr = stderr
      await run(test)
      const end = await reviewEnd(test)
      expect(end.data.text).toContain('terminated by SIGKILL')
      if (stderr !== undefined && stderr.length > 400) expect(end.data.text).toContain(`…${'x'.repeat(400)}`)
    }
  })

  it('rejects whitespace-only final output', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = reviewJson('   ')
    await run(test)
    expect((await reviewEnd(test)).data.text).toContain('without producing review output')
  })

  it('extracts a final agent message from the unterminated last line', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = JSON.stringify({
      type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'Last line.' },
    })
    await run(test)
    expect((await reviewEnd(test)).data).toMatchObject({ outcome: 'completed', text: 'Last line.' })
  })

  it('rejects a second concurrent review for the same Agent by default', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    const first = await run(test, ' first')
    const second = await run(test, ' second')
    expect(first.result.kind).toBe('success')
    expect(second.result).toEqual({
      kind: 'error',
      text: 'This agent already has 1 active review(s); the configured limit is 1.',
    })
    expect(test.subprocess.spawns).toHaveLength(1)
    await test.plugin.dispose()
    expect(test.subprocess.terminations).toHaveLength(1)
    expect(test.subprocess.terminations[0]).toHaveBeenCalledOnce()
  })

  it('reserves the Agent limit before asynchronous executable resolution', async () => {
    const test = await harness()
    seed(test)
    const resolution = Promise.withResolvers<undefined>()
    test.subprocess.resolveGate = resolution.promise

    const first = run(test, ' first')
    await vi.waitFor(() => { expect(test.subprocess.lookups).toEqual(['codex']) })
    const second = await run(test, ' second')
    expect(second.result).toMatchObject({ kind: 'error' })
    expect(test.subprocess.lookups).toEqual(['codex'])

    resolution.resolve(undefined)
    expect((await first).result.kind).toBe('success')
    await test.plugin.dispose()
  })

  it('admits another review after the first one settles', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    await run(test, ' first')
    test.subprocess.complete(reviewJson('First.'))
    await reviewEnd(test)

    test.subprocess.liveStream = undefined
    test.subprocess.liveDone = undefined
    const second = await run(test, ' second')
    expect(second.result.kind).toBe('success')
    expect(test.subprocess.spawns).toHaveLength(2)
    await test.plugin.dispose()
  })

  it('honors a configured per-Agent concurrency limit', async () => {
    const test = await harness({ config: { maxConcurrentReviews: 2 } })
    seed(test)
    test.subprocess.manual = true
    expect((await run(test, ' first')).result.kind).toBe('success')
    expect((await run(test, ' second')).result.kind).toBe('success')
    expect((await run(test, ' third')).result.kind).toBe('error')
    expect(test.subprocess.spawns).toHaveLength(2)
    await test.plugin.dispose()
  })

  it('bounds the complete UTF-8 review prompt before persistence and spawn', async () => {
    const transcript = 'User: fix the bug\nAgent: done'
    const boundary = '00000000-0000-0000-0000-000000000000'
    const exactPrompt = commandReviewer.buildReviewPrompt(
      commandReviewer.DEFAULT_REVIEW_PROMPT, '', '', transcript, boundary,
    )
    const exactBytes = Buffer.byteLength(exactPrompt)
    const exact = await harness({ config: { maxPromptBytes: exactBytes } })
    seed(exact)
    expect((await run(exact)).result.kind).toBe('success')
    expect(exact.subprocess.spawns).toHaveLength(1)

    const oversized = await harness({ config: { maxPromptBytes: exactBytes - 1 } })
    seed(oversized)
    expect((await run(oversized)).result).toEqual({
      kind: 'error',
      text: `The review prompt is ${exactBytes} bytes; the configured limit is ${exactBytes - 1} bytes.`,
    })
    expect(oversized.subprocess.spawns).toEqual([])
    expect(oversized.agent.session.events.some(event => event.type === 'review/start')).toBe(false)
    const oversizedRun = oversized.agent.session.events.find(event => event.type === 'command/run')
    expect(oversizedRun?.data).not.toHaveProperty('args')

    const focus = '审查'
    const multibytePrompt = commandReviewer.buildReviewPrompt(
      commandReviewer.DEFAULT_REVIEW_PROMPT, '', focus, transcript, boundary,
    )
    const multibyteBytes = Buffer.byteLength(multibytePrompt)
    const multibyte = await harness({ config: { maxPromptBytes: multibyteBytes - 1 } })
    seed(multibyte)
    expect((await run(multibyte, ` ${focus}`)).result).toEqual({
      kind: 'error',
      text: `The review prompt is ${multibyteBytes} bytes; the configured limit is ${multibyteBytes - 1} bytes.`,
    })
    expect(multibyte.subprocess.spawns).toEqual([])

    const tiny = await harness({ config: { maxPromptBytes: 1 } })
    seed(tiny)
    expect((await run(tiny)).result.kind).toBe('error')
    expect(tiny.subprocess.spawns).toEqual([])
  })

  it('terminates the process tree and records a visible timeout failure', async () => {
    const test = await harness({ config: { timeoutMs: 10 } })
    seed(test)
    test.subprocess.manual = true
    test.subprocess.manualWait = true
    test.subprocess.terminateStreamError = true
    await run(test)

    await vi.waitFor(() => {
      expect(test.subprocess.terminations[0]).toHaveBeenCalledOnce()
      expect(test.subprocess.waits[0]).toHaveBeenCalledOnce()
    })
    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)
    test.subprocess.waitGates[0]?.resolve(true)
    const end = await reviewEnd(test)
    expect(end.data.outcome).toBe('failed')
    expect(end.data.text).toContain('Timed out after 10ms.')
    expect(end.data.text).toContain('Codex output failed: terminated stream')
    expect(end.data.text).toContain('Codex was terminated by SIGTERM.')
  })

  it('classifies a cleanly closed stream after deadline as timed out', async () => {
    const test = await harness({ config: { timeoutMs: 10 } })
    seed(test)
    test.subprocess.manual = true
    await run(test)

    expect((await reviewEnd(test)).data).toEqual(expect.objectContaining({
      outcome: 'failed',
    }))
  })

  it('combines timeout, structured failure, and signal termination', async () => {
    const test = await harness({ config: { timeoutMs: 10 } })
    seed(test)
    test.subprocess.manual = true
    await run(test)
    test.subprocess.liveStream?.write(`${JSON.stringify({ type: 'error', message: 'upstream failed' })}\n`)

    const text = (await reviewEnd(test)).data.text
    expect(text).toContain('Timed out after 10ms.')
    expect(text).toContain('Codex reported: upstream failed')
    expect(text).toContain('Codex was terminated by SIGTERM.')
  })

  it('keeps the review owned when process-tree exit cannot be confirmed after an output failure', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.nextStdout = '{bad}\n'
    test.subprocess.waitError = new Error('tree liveness probe failed')
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const logged = vi.spyOn(test.ctx.logger, 'error')

    await run(test)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('tree liveness probe failed'))
    })

    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)
    expect((await run(test, ' retry')).result).toMatchObject({ kind: 'error' })
    await expect(test.plugin.dispose()).resolves.toBeUndefined()
    expect(logged.mock.calls.some(([error]) => String(error).includes('subprocess cleanup failed before quiescence'))).toBe(true)
  })

  it('requires an affirmative process-tree exit result', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.waitResult = false
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await run(test)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('without confirming exit'))
    })

    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)
    await test.plugin.dispose()
  })

  it('combines an output failure with an independent process-completion rejection', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.terminateDoneError = new Error('spawn transport failed')
    await run(test)

    test.subprocess.liveStream?.write('{bad}\n')
    test.subprocess.liveStream?.end()

    const end = await reviewEnd(test)
    expect(end.data.outcome).toBe('failed')
    expect(end.data.text).toMatch(/invalid JSON.*Codex process completion failed: spawn transport failed/su)
  })

  it('keeps a timed-out review owned when process-tree exit cannot be confirmed', async () => {
    const test = await harness({ config: { timeoutMs: 10 } })
    seed(test)
    test.subprocess.manual = true
    test.subprocess.terminateStreamError = true
    test.subprocess.waitError = new Error('timeout tree liveness probe failed')
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const logged = vi.spyOn(test.ctx.logger, 'error')

    await run(test)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout tree liveness probe failed'))
    })

    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)
    await expect(test.plugin.dispose()).resolves.toBeUndefined()
    expect(logged.mock.calls.some(([error]) => String(error).includes('subprocess cleanup failed before quiescence'))).toBe(true)
  })

  it('resolves a batch wrapper and command interpreter in the subprocess provider world', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.resolvedExecutable = String.raw`C:\\sandbox\\bin\\codex.cmd`
    await run(test)

    expect(test.subprocess.lookups).toEqual(['codex', 'cmd.exe'])
    expect(test.subprocess.spawns[0]).toMatchObject({
      argv: [
        '/resolved/cmd.exe', '/d', '/q', '/v:off', '/s', '/c',
        '%DSH_CODEX_REVIEWER_EXECUTABLE% exec --json --color never --ephemeral --skip-git-repo-check -s read-only -c model_reasoning_effort=medium',
      ],
      env: { DSH_CODEX_REVIEWER_EXECUTABLE: String.raw`"C:\\sandbox\\bin\\codex.cmd"` },
    })
  })

  it('settles a spawn failure in the durable reviewer card', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.spawnError = new Error('spawn exploded')
    const execution = await run(test)
    expect(execution.result.kind).toBe('success')
    expect((await reviewEnd(test)).data).toMatchObject({ outcome: 'failed', text: 'The review could not start: spawn exploded' })
  })

  it('records owner cancellation when teardown reenters through a throwing spawn', async () => {
    const test = await harness()
    seed(test)
    let disposal: Promise<void> | undefined
    test.subprocess.beforeSpawn = () => {
      disposal = test.plugin.dispose()
      throw new Error('spawn failed after teardown')
    }

    const execution = await run(test)

    expect(execution.result.kind).toBe('success')
    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'cancelled',
      text: 'Review cancelled because its owner stopped.',
    })
    await expect(disposal).resolves.toBeUndefined()
  })

  it('releases its owner reservation when review/start cannot be appended', async () => {
    const test = await harness()
    seed(test)
    const append = test.agent.session.append.bind(test.agent.session)
    const failingAppend: Session['append'] = (type, data, ...opts) => {
      if (type === 'review/start') throw new Error('start append failed')
      return append(type, data, ...opts)
    }
    Object.defineProperty(test.agent.session, 'append', { configurable: true, value: failingAppend })

    await expect(run(test)).rejects.toThrow('start append failed')
    expect(test.subprocess.spawns).toEqual([])
    await expect(test.plugin.dispose()).resolves.toBeUndefined()
  })

  it('renders a non-Error spawn failure', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.spawnError = 'spawn string failure'
    await run(test)
    expect((await reviewEnd(test)).data.text).toContain('spawn string failure')
  })

  it('cancels and drains the process on plugin teardown', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.manualWait = true
    await run(test)
    let disposed = false
    const disposal = test.plugin.dispose()
    void disposal.then(() => { disposed = true })
    await vi.waitFor(() => { expect(test.subprocess.waits[0]).toHaveBeenCalledOnce() })
    expect(disposed).toBe(false)
    test.subprocess.waitGates[0]?.resolve(true)
    await disposal
    expect(disposed).toBe(true)
    expect(test.subprocess.terminations[0]).toHaveBeenCalledOnce()
    expect((await reviewEnd(test)).data).toMatchObject({ outcome: 'cancelled' })
  })

  it('rejects teardown without a terminal record when process-tree exit cannot be confirmed', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.waitError = new Error('teardown tree liveness probe failed')
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const logged = vi.spyOn(test.ctx.logger, 'error')
    await run(test)

    await expect(test.plugin.dispose()).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('teardown tree liveness probe failed'))
    expect(logged.mock.calls.some(([error]) => String(error).includes('subprocess cleanup failed before quiescence'))).toBe(true)
    expect(test.agent.session.events.some(event => event.type === 'review/end')).toBe(false)
  })

  it('classifies a stream failure during owner cancellation as cancelled', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.terminateStreamError = true
    await run(test)
    await test.plugin.dispose()
    const end = await reviewEnd(test)
    expect(end.data.outcome).toBe('cancelled')
    expect(end.data.text).toContain('Codex output failed: terminated stream')
    expect(end.data.text).toContain('Codex was terminated by SIGTERM.')
  })

  it('keeps a clean cancellation concise when Codex exits cleanly with final output', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.terminateOutcome = { exitCode: 0, signal: null }
    await run(test)
    test.subprocess.liveStream?.write(reviewJson())

    await test.plugin.dispose()

    expect((await reviewEnd(test)).data).toMatchObject({
      outcome: 'cancelled', text: 'Review cancelled because its owner stopped.',
    })
  })

  it('reports process-completion rejection during owner cancellation', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    test.subprocess.terminateDoneError = new Error('completion transport failed')
    await run(test)
    test.subprocess.liveStream?.write(reviewJson())

    await test.plugin.dispose()

    const end = await reviewEnd(test)
    expect(end.data.outcome).toBe('cancelled')
    expect(end.data.text).toContain('Codex process completion failed: completion transport failed')
  })

  it('retains ownership when review/end append fails in background and spawn-failure paths', async () => {
    const background = await harness()
    seed(background)
    background.subprocess.manual = true
    const backgroundWarn = vi.spyOn(background.ctx.logger, 'warn')
    await run(background)
    rejectReviewEnd(background, new Error('end append failed'))
    background.subprocess.complete()
    await vi.waitFor(() => {
      expect(backgroundWarn).toHaveBeenCalledWith(expect.stringContaining('end append failed'))
    })
    const backgroundRetry = (await run(background)).result
    expect(backgroundRetry.kind).toBe('error')
    expect(backgroundRetry.text).toContain('1 active review')

    const spawn = await harness()
    seed(spawn)
    spawn.subprocess.spawnError = new Error('spawn failed')
    rejectReviewEnd(spawn, 'spawn end append failed')
    const spawnWarn = vi.spyOn(spawn.ctx.logger, 'warn')
    await run(spawn)
    expect(spawnWarn).toHaveBeenCalledWith(expect.stringContaining('spawn end append failed'))
    const spawnRetry = (await run(spawn)).result
    expect(spawnRetry.kind).toBe('error')
    expect(spawnRetry.text).toContain('1 active review')
  })

  it('retains ownership when review/end cannot reach durable storage', async () => {
    const test = await harness()
    seed(test)
    test.subprocess.manual = true
    let flushes = 0
    test.ctx.on('session/flush', () => {
      flushes += 1
      if (flushes === 2) throw new Error('terminal storage unavailable')
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await run(test)
    test.subprocess.complete()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal storage unavailable'))
    })

    const retry = (await run(test)).result
    expect(retry.kind).toBe('error')
    expect(retry.text).toContain('1 active review')
  })

  it('handles disabled, empty, executable failures, and pre-aborted admission without a process', async () => {
    const disabled = await harness({ config: { enabled: false } })
    seed(disabled)
    expect((await run(disabled)).result.kind).toBe('error')
    const empty = await harness()
    const emptyResult = (await run(empty)).result
    expect(emptyResult.kind).toBe('success')
    expect(emptyResult.text).toContain('No conversation')
    empty.agent.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'hidden' }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    const hiddenOnlyResult = (await run(empty)).result
    expect(hiddenOnlyResult.kind).toBe('success')
    expect(hiddenOnlyResult.text).toContain('No conversation')
    const missing = await harness()
    seed(missing)
    missing.subprocess.resolveError = new Error('subprocess-local: command "codex" was not found on PATH')
    const missingResult = (await run(missing)).result
    expect(missingResult.kind).toBe('error')
    expect(missingResult.text).toBe(
      'The reviewer could not resolve the Codex CLI: subprocess-local: command "codex" was not found on PATH',
    )
    const unavailable = await harness()
    seed(unavailable)
    unavailable.subprocess.resolveError = new Error('remote sandbox unavailable')
    expect((await run(unavailable)).result).toEqual({
      kind: 'error',
      text: 'The reviewer could not resolve the Codex CLI: remote sandbox unavailable',
    })
    const definition = missing.ctx.commands.find(missing.agent, 'review')
    if (definition === undefined) throw new Error('review command missing')
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    expect(await definition.handler({
      commandId: CommandId('pre-aborted'), agent: missing.agent, rawInput: '', attachments: [], signal: aborted.signal,
      commit: () => { aborted.signal.throwIfAborted() },
    }))
      .toEqual({ kind: 'error', text: 'Review cancelled.' })
    expect(disabled.subprocess.spawns).toEqual([])
    expect(empty.subprocess.spawns).toEqual([])
    expect(missing.subprocess.spawns).toEqual([])
    expect(unavailable.subprocess.spawns).toEqual([])
  })

  it('stops admission when the browser aborts after executable resolution', async () => {
    const test = await harness()
    seed(test)
    const browser = new AbortController()
    test.subprocess.afterResolve = () => { browser.abort(new Error('disconnected')) }
    const definition = test.ctx.commands.find(test.agent, 'review')
    if (definition === undefined) throw new Error('review command missing')
    expect(await definition.handler({
      commandId: CommandId('post-resolve-abort'), agent: test.agent, rawInput: '', attachments: [], signal: browser.signal,
      commit: () => { browser.signal.throwIfAborted() },
    })).toEqual({ kind: 'error', text: 'Review cancelled.' })
    expect(test.subprocess.spawns).toEqual([])
  })

  it('stops admission when owner teardown aborts executable resolution', async () => {
    const test = await harness()
    seed(test)
    const gate = Promise.withResolvers<undefined>()
    test.subprocess.resolveGate = gate.promise
    const execution = run(test)
    await vi.waitFor(() => { expect(test.subprocess.lookups).toEqual(['codex']) })
    const disposal = test.plugin.dispose()
    gate.resolve(undefined)

    expect((await execution).result).toEqual({ kind: 'error', text: 'Review owner is stopping.' })
    await disposal
    expect(test.subprocess.spawns).toEqual([])
  })

  it('stops admission when teardown follows successful executable resolution', async () => {
    const test = await harness()
    seed(test)
    let disposal: Promise<void> | undefined
    test.subprocess.afterResolve = () => { disposal = test.plugin.dispose() }

    expect((await run(test)).result).toEqual({ kind: 'error', text: 'Review owner is stopping.' })
    await disposal
    expect(test.subprocess.spawns).toEqual([])
  })
})

describe('command-reviewer settings section', () => {
  it('reads the latest settings for a new run', async () => {
    const test = await harness({ settings: true })
    seed(test)
    await test.ctx.settings.update(commandReviewer.REVIEWER_SETTINGS_NAMESPACE, {
      model: 'gpt-5.1-codex-max', thinkingEffort: 'low', sandbox: 'workspace-write',
    })
    await run(test)
    expect(test.subprocess.spawns[0]?.argv).toEqual(expect.arrayContaining([
      '-m', 'gpt-5.1-codex-max', 'model_reasoning_effort=low', 'workspace-write',
    ]))
  })

  it('rejects a model value that could be interpreted by the Windows command wrapper', async () => {
    const test = await harness({ settings: true })
    await expect(test.ctx.settings.update(commandReviewer.REVIEWER_SETTINGS_NAMESPACE, {
      model: 'gpt-5.1-codex-mini & whoami',
    })).rejects.toThrow()
    expect(test.subprocess.spawns).toEqual([])
  })
})
