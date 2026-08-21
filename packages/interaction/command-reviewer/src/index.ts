/**
 * Human-facing `/review` command over the local Codex CLI. The command only
 * admits a review and returns a durable start acknowledgement; the owned
 * process then records Codex JSONL progress and its final result in the same
 * Session without entering the reviewed agent's model history.
 * @module @deepseek-ai/dsh-command-reviewer
 */

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  buildReviewPrompt, codexNeedsCommandInterpreter, codexReviewLaunch, parseCodexJsonLine, renderTranscript,
  CODEX_MODEL_PATTERN, CODEX_SANDBOX_MODES, CODEX_THINKING_EFFORTS,
  type CodexSandbox, type CodexThinkingEffort,
} from './codex.ts'
import type { ReviewEndData, ReviewStartData } from './types.ts'
import type {} from './types.ts'

export {
  buildReviewPrompt, codexNeedsCommandInterpreter, codexReviewLaunch, parseCodexJsonLine, renderTranscript,
  CODEX_BATCH_EXECUTABLE_ENV, CODEX_MODEL_PATTERN, CODEX_SANDBOX_MODES, CODEX_THINKING_EFFORTS, TRANSCRIPT_PLACEHOLDER,
} from './codex.ts'
export type { CodexJsonProgress, CodexReviewLaunch, CodexReviewOptions, CodexSandbox, CodexThinkingEffort } from './codex.ts'
export type {
  ReviewActivityData, ReviewActivityId, ReviewActivityKind, ReviewActivityStatus, ReviewEndData, ReviewOutcome,
  ReviewRequestData,
  ReviewStartData,
} from './types.ts'

export const name = 'command-reviewer'

/** Required services: commands, live sessions, durable session storage, and the subprocess seam. */
export const inject = ['commands', 'sessions', 'sessionPersistence', 'subprocess']

/** Default review instructions sent to Codex when the section carries none. */
export const DEFAULT_REVIEW_PROMPT = [
  'You are reviewing the conversation transcript of another coding agent ("Agent").',
  'Review the agent\'s work critically and constructively:',
  '- point out correctness bugs, design weaknesses, missed edge cases, and risky assumptions;',
  '- verify that the agent\'s claims match what the tools actually returned;',
  '- flag the concrete follow-ups the agent should perform next.',
  'Keep the review actionable, and answer in the same language as the conversation.',
].join('\n')

/** In-memory cap in bytes for Codex stderr, kept as a diagnostic tail. */
const STDERR_TAIL_BYTES = 4_096
/** Characters of the stderr tail quoted in a failed-run result. */
const STDERR_QUOTE_CHARS = 400
/** Default tail-keep bound in characters for the rendered transcript. */
const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000
/** Default byte cap for the complete prompt persisted and written to Codex. */
const DEFAULT_MAX_PROMPT_BYTES = 1_048_576
/** Default complete JSONL output cap in bytes. */
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608
/** Default cap for durable activity transitions emitted by one review. */
const DEFAULT_MAX_ACTIVITY_EVENTS = 1_000
/** Default provider grace for process termination and collected-pipe draining. */
const DEFAULT_SUBPROCESS_GRACE_MS = 3_000
/** Default maximum elapsed time for one Codex review. */
const DEFAULT_TIMEOUT_MS = 3_600_000
/** Default bound from owner teardown through review quiescence. */
const DEFAULT_TEARDOWN_TIMEOUT_MS = 10_000
/** Default concurrent review limit for one Agent. */
const DEFAULT_MAX_CONCURRENT_REVIEWS = 1
/** Timeout identity used to distinguish elapsed deadlines from owner teardown. */
const REVIEW_TIMEOUT = 'COMMAND_REVIEW_TIMEOUT'
/** Timeout identity for owner teardown that cannot reach review quiescence. */
const REVIEW_TEARDOWN_TIMEOUT = 'COMMAND_REVIEW_TEARDOWN_TIMEOUT'

/** User-settings section of the reviewer command. */
export interface Config {
  /** Whether `/review` runs at all — the card's enable switch. */
  enabled?: boolean
  /** `codex exec --model`; empty uses the Codex default model. */
  model?: string
  /** `codex exec -c model_reasoning_effort=…` level. */
  thinkingEffort?: CodexThinkingEffort
  /** `codex exec --sandbox` policy. */
  sandbox?: CodexSandbox
  /** Review instructions; `{transcript}` marks where the conversation goes. */
  prompt?: string
  /** Deployment-level scenario context appended to the prompt. */
  context?: string
  /** Tail-keep bound in characters for the rendered transcript. */
  maxTranscriptChars?: number
  /** UTF-8 byte cap for the complete prompt after all sections are assembled. */
  maxPromptBytes?: number
  /** Complete Codex JSONL output cap in bytes. */
  maxOutputBytes?: number
  /** Maximum durable activity transitions decoded from one Codex run. */
  maxActivityEvents?: number
  /** Provider termination and collected-pipe drain grace; Windows force-terminates immediately. */
  subprocessGraceMs?: number
  /** Maximum elapsed time for one review before its process tree is terminated. */
  timeoutMs?: number
  /** Maximum elapsed time from owner teardown through process and lifecycle quiescence. */
  teardownTimeoutMs?: number
  /** Maximum reviews admitted concurrently for one Agent. */
  maxConcurrentReviews?: number
}

/** A section whose optional members all carry schema defaults. */
function resolvedConfig(config: Config): Required<Config> {
  return config as Required<Config>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  model: z.string().pattern(CODEX_MODEL_PATTERN).default(''),
  thinkingEffort: z.union(CODEX_THINKING_EFFORTS).default('medium'),
  sandbox: z.union(CODEX_SANDBOX_MODES).default('read-only'),
  prompt: z.string().default(DEFAULT_REVIEW_PROMPT),
  context: z.string().default(''),
  maxTranscriptChars: z.number().step(1).min(1).default(DEFAULT_MAX_TRANSCRIPT_CHARS),
  maxPromptBytes: z.number().step(1).min(1).default(DEFAULT_MAX_PROMPT_BYTES),
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  maxActivityEvents: z.number().step(1).min(1).default(DEFAULT_MAX_ACTIVITY_EVENTS),
  subprocessGraceMs: z.number().step(1).min(1).default(DEFAULT_SUBPROCESS_GRACE_MS),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
  teardownTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TEARDOWN_TIMEOUT_MS),
  maxConcurrentReviews: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_REVIEWS),
})

/** Settings namespace carrying the reviewer's user-facing configuration. */
export const REVIEWER_SETTINGS_NAMESPACE = settingsNamespace('command-reviewer')

const DISABLED: CommandResult = {
  kind: 'error',
  text: 'The reviewer is disabled. Turn it on under Settings → Plugins.',
}
const NO_HISTORY: CommandResult = {
  kind: 'success',
  text: 'No conversation output to review yet.',
}
const CANCELLED: CommandResult = { kind: 'error', text: 'Review cancelled.' }
const INTERRUPTED_REVIEW_TEXT = 'Review interrupted because its previous host stopped before recording completion.'
const FORKED_REVIEW_TEXT = 'Review was not continued in this fork; the source session review is unaffected.'
function assertConfig(config: Required<Config>): void {
  if (config.subprocessGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`command-reviewer: subprocessGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (config.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`command-reviewer: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (config.teardownTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`command-reviewer: teardownTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function renderThrown(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(renderThrown).join('; ')}`
  }
  return error instanceof Error ? error.message : String(error)
}

function stderrQuote(handle: SubprocessHandle): string {
  const stderr = handle.collected.stderr
  if (stderr === undefined) return ''
  const text = stderr.readFrom(0).text.trim()
  if (text.length === 0) return ''
  const tail = text.length > STDERR_QUOTE_CHARS ? `…${text.slice(text.length - STDERR_QUOTE_CHARS)}` : text
  return `: ${tail}`
}

function appendReviewEvent<T extends 'review/start' | 'review/activity' | 'review/end'>(
  session: Session,
  type: T,
  data: SessionEventMap[T],
): SessionEvent<T> {
  const append = session.append.bind(session) as (eventType: T, eventData: SessionEventMap[T]) => SessionEvent<T>
  return append(type, data)
}

type ReviewLifecycleEvent = SessionEvent<'review/start'> | SessionEvent<'review/end'>

interface ReviewFlushFailure {
  readonly reason: unknown
}

function throwReviewLifecycleFailure(
  flushFailure: ReviewFlushFailure | undefined,
  verificationFailure: unknown,
  expected: ReviewLifecycleEvent,
): never {
  if (flushFailure === undefined) throw verificationFailure
  throw new AggregateError(
    [flushFailure.reason, verificationFailure],
    `command-reviewer: session flush failed (${renderThrown(flushFailure.reason)}) and ${expected.type} durability verification failed (${renderThrown(verificationFailure)})`,
  )
}

async function waitForSignal<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([start(), aborted.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Flush every listener, then independently verify the expected lifecycle event in durable storage. */
async function flushReviewLifecycle(
  ctx: Context,
  session: Session,
  expected: ReviewLifecycleEvent,
  signal: AbortSignal,
): Promise<ReviewFlushFailure | undefined> {
  let flushFailure: ReviewFlushFailure | undefined
  try {
    await waitForSignal(() => ctx.sessions.flush(session), signal)
  } catch (reason: unknown) {
    flushFailure = { reason }
  }
  let stored: SessionEvent | undefined
  try {
    stored = (await ctx.sessionPersistence.readFrom(session.id, expected.seq, signal)).events
      .find(event => event.seq === expected.seq)
  } catch (error: unknown) {
    throwReviewLifecycleFailure(flushFailure, error, expected)
  }
  if (!isDeepStrictEqual(stored, expected)) {
    throwReviewLifecycleFailure(
      flushFailure,
      new Error(`command-reviewer: durable session log does not contain ${expected.type} seq ${expected.seq}`),
      expected,
    )
  }
  return flushFailure
}

async function flushReviewEnd(
  ctx: Context,
  session: Session,
  terminal: SessionEvent<'review/end'>,
  signal: AbortSignal,
): Promise<void> {
  const failure = await flushReviewLifecycle(ctx, session, terminal, signal)
  if (failure !== undefined) {
    ctx.logger.warn(`command-reviewer: review/end seq ${terminal.seq} reached durable storage despite session flush failure: ${renderThrown(failure.reason)}`)
  }
}

/** Settle review and command prefixes whose owning Host is gone. */
function recoverInterruptedReviews(agent: Agent): void {
  const starts = new Map<ReviewStartData['commandId'], SessionEvent<'review/start'>>()
  const ended = new Set<ReviewStartData['commandId']>()
  const settledCommands = new Set<ReviewStartData['commandId']>()
  for (const event of agent.session.events) {
    if (event.type === 'review/start') starts.set(event.data.commandId, event)
    else if (event.type === 'review/end') ended.add(event.data.commandId)
    else if (event.type === 'command/done') settledCommands.add(event.data.commandId)
  }
  for (const [commandId, start] of starts) {
    if (!settledCommands.has(commandId)) {
      agent.session.append('command/done', {
        commandId, kind: 'success', sourceEventSeq: start.seq,
      })
    }
    if (ended.has(commandId)) continue
    appendReviewEvent(agent.session, 'review/end', {
      commandId,
      outcome: 'interrupted',
      text: agent.session.header.parentSession !== undefined
        && agent.session.header.seedLength !== undefined
        && start.seq < agent.session.header.seedLength
        ? FORKED_REVIEW_TEXT
        : INTERRUPTED_REVIEW_TEXT,
    })
  }
}

function chunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  throw new Error('Codex stdout emitted a non-byte chunk')
}

interface ParsedOutput {
  readonly finalText?: string
  readonly failures: readonly string[]
}

/** JSONL read failure with every result decoded before the failing byte. */
class CodexOutputError extends Error {
  /** Partial output observed before the reader failed. */
  readonly output: ParsedOutput

  /** @param cause - the JSONL, stream, or output-limit failure. @param output - partial decoded output. */
  constructor(cause: unknown, output: ParsedOutput) {
    super(renderThrown(cause), { cause })
    this.output = output
  }
}

async function readJsonl(
  handle: SubprocessHandle,
  config: Required<Config>,
  session: Session,
  commandId: ReviewStartData['commandId'],
): Promise<ParsedOutput> {
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let bytes = 0
  let activityEvents = 0
  let finalText: string | undefined
  const failures: string[] = []
  const snapshot = (): ParsedOutput => ({
    ...finalText === undefined ? {} : { finalText },
    failures: [...failures],
  })

  const consume = (text: string): void => {
    carry += text
    const lines = carry.split('\n')
    /* v8 ignore next -- split() always returns at least one element. */
    carry = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const progress = parseCodexJsonLine(trimmed)
      if (progress.finalText !== undefined) finalText = progress.finalText
      if (progress.failure !== undefined) failures.push(progress.failure)
      if (progress.activity !== undefined) {
        if (activityEvents >= config.maxActivityEvents) {
          throw new Error(`Codex output exceeded configured activity-event limit of ${config.maxActivityEvents}`)
        }
        activityEvents += 1
        appendReviewEvent(session, 'review/activity', {
          commandId,
          ...progress.activity,
        })
      }
    }
  }

  const consumeBytes = (bytesChunk: Buffer): void => {
    const remaining = config.maxOutputBytes - bytes
    const accepted = bytesChunk.subarray(0, Math.max(0, remaining))
    bytes += bytesChunk.byteLength
    consume(decoder.write(accepted))
    if (bytes > config.maxOutputBytes) {
      throw new Error(`Codex JSONL output exceeded configured limit of ${config.maxOutputBytes} bytes`)
    }
  }

  try {
    if (handle.stdout === undefined) {
      const collected = handle.collected.stdout
      if (collected === undefined) throw new Error('Codex stdout pipe is unavailable')
      const bytesChunk = Buffer.from(collected.readFrom(0).text)
      consumeBytes(bytesChunk)
    } else {
      for await (const chunk of handle.stdout) {
        const bytesChunk = chunkBuffer(chunk)
        consumeBytes(bytesChunk)
      }
    }
    consume(`${decoder.end()}\n`)
    return snapshot()
  } catch (error: unknown) {
    throw new CodexOutputError(error, snapshot())
  }
}

function exitDiagnostic(handle: SubprocessHandle, outcome: SubprocessOutcome): string {
  if (outcome.exitCode === null && outcome.signal !== null) {
    return `Codex was terminated by ${outcome.signal}${stderrQuote(handle)}.`
  }
  return `Codex exited with code ${String(outcome.exitCode)}${stderrQuote(handle)}.`
}

interface ReviewOperation {
  readonly controller: AbortController
  readonly teardownSignal: AbortSignal
  readonly settled: Promise<void>
  readonly stop: () => void
  readonly finish: () => void
  failure?: unknown
}

interface ReviewOwner {
  readonly active: Set<ReviewOperation>
  stopping: boolean
  cleanup: () => void | Promise<void>
}

function ensureOwner(
  owners: Map<Agent, ReviewOwner>,
  agent: Agent,
): ReviewOwner {
  const existing = owners.get(agent)
  if (existing !== undefined) return existing
  const owner: ReviewOwner = {
    active: new Set(),
    stopping: false,
    /* v8 ignore next -- replaced synchronously before the owner enters the map. */
    cleanup: () => {},
  }
  owner.cleanup = agent.ctx.effect(() => async () => {
    owner.stopping = true
    const operations = [...owner.active]
    for (const operation of operations) operation.stop()
    await Promise.all(operations.map(operation => operation.settled))
    const failures = operations.flatMap(operation => operation.failure === undefined ? [] : [operation.failure])
    if (failures.length > 0) {
      throw new AggregateError(failures, 'command-reviewer: subprocess cleanup failed before quiescence')
    }
    /* v8 ignore next -- this disposer belongs to the same owner stored for this Agent. */
    if (owners.get(agent) === owner) owners.delete(agent)
  }, 'command-reviewer.agent()')
  owners.set(agent, owner)
  return owner
}

async function flushReviewStart(
  ctx: Context,
  session: Session,
  start: SessionEvent<'review/start'>,
  signal: AbortSignal,
): Promise<void> {
  const failure = await flushReviewLifecycle(ctx, session, start, signal)
  if (failure !== undefined) throw failure.reason
}

async function confirmProcessTreeExit(handle: SubprocessHandle, signal: AbortSignal): Promise<void> {
  if (!await handle.waitForExit(signal)) {
    throw new Error('Codex process-tree exit wait ended without confirming exit')
  }
}

function renderFailedReview(completedText: string, diagnostics: readonly string[]): string {
  if (completedText.length > 0) {
    return `${completedText}\n\nThe review produced output but did not finish cleanly:\n${diagnostics
      .map(diagnostic => `- ${diagnostic}`).join('\n')}`
  }
  if (diagnostics.length === 1) return `The review failed: ${diagnostics[0]}`
  return `The review failed:\n${diagnostics.map(diagnostic => `- ${diagnostic}`).join('\n')}`
}

function renderCancelledReview(diagnostics: readonly string[]): string {
  const summary = 'Review cancelled because its owner stopped.'
  return diagnostics.length === 0
    ? summary
    : `${summary}\n${diagnostics.map(diagnostic => `- ${diagnostic}`).join('\n')}`
}

async function runReview(
  ctx: Context,
  handle: SubprocessHandle,
  session: Session,
  commandId: ReviewStartData['commandId'],
  config: Required<Config>,
  signal: AbortSignal,
  teardownSignal: AbortSignal,
): Promise<void> {
  let output: ParsedOutput
  let terminationRequested = false
  let terminationFailure: unknown
  const terminate = (): void => {
    if (terminationRequested) return
    terminationRequested = true
    try {
      handle.terminate()
    } catch (error: unknown) {
      terminationFailure = error
    }
  }
  const outputPromise = readJsonl(handle, config, session, commandId).catch((error: unknown) => {
    if (!signal.aborted) terminate()
    throw error
  })
  const outcomePromise = handle.done.then(
    (outcome) => {
      if (!signal.aborted) terminate()
      return outcome
    },
    (error: unknown) => {
      if (!signal.aborted) terminate()
      throw error
    },
  )
  const subprocessResults = Promise.allSettled([outputPromise, outcomePromise])
  const [outputResult, outcomeResult] = await waitForSignal(() => subprocessResults, teardownSignal)
  await confirmProcessTreeExit(handle, teardownSignal)

  const timedOut = timeoutOf(signal, REVIEW_TIMEOUT) !== undefined
  const cancelled = signal.aborted && !timedOut
  const diagnostics: string[] = []
  if (timedOut) diagnostics.push(`Timed out after ${config.timeoutMs}ms.`)
  if (outputResult.status === 'fulfilled') {
    output = outputResult.value
    diagnostics.push(...output.failures.map(failure => `Codex reported: ${failure}`))
  } else {
    const failure = outputResult.reason as CodexOutputError
    output = failure.output
    diagnostics.push(...output.failures.map(message => `Codex reported: ${message}`))
    diagnostics.push(`Codex output failed: ${renderThrown(failure)}`)
  }
  if (outcomeResult.status === 'fulfilled') {
    if (outcomeResult.value.exitCode !== 0) diagnostics.push(exitDiagnostic(handle, outcomeResult.value))
  } else {
    diagnostics.push(`Codex process completion failed: ${renderThrown(outcomeResult.reason)}`)
  }
  if (terminationFailure !== undefined) {
    diagnostics.push(`Codex termination request failed: ${renderThrown(terminationFailure)}`)
  }
  if (diagnostics.length === 0 && (output.finalText === undefined || output.finalText.trim().length === 0)) {
    diagnostics.push('Codex completed without producing review output.')
  }
  const completedText = output.finalText?.trim() ?? ''
  const end: ReviewEndData = cancelled
    ? { commandId, outcome: 'cancelled', text: renderCancelledReview(diagnostics) }
    : diagnostics.length === 0
      ? { commandId, outcome: 'completed', text: completedText }
      : { commandId, outcome: 'failed', text: renderFailedReview(completedText, diagnostics) }
  const terminal = appendReviewEvent(session, 'review/end', end)
  await flushReviewEnd(ctx, session, terminal, teardownSignal)
}

/** Register the `/review` command and its settings section. */
export function apply(ctx: Context, config: Config): void {
  assertConfig(resolvedConfig(config))
  let current: () => Config = () => config
  installSettingsSection(ctx, REVIEWER_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
    validate: (value) => { assertConfig(resolvedConfig(value)) },
  })

  const owners = new Map<Agent, ReviewOwner>()
  ctx.on('agent/session-start', ({ agent }) => { recoverInterruptedReviews(agent) })
  const handler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const resolved = resolvedConfig(current())
    if (!resolved.enabled) return DISABLED
    const messages = invocation.agent.session.deriveMessages()
    if (messages.length === 0) return NO_HISTORY
    const transcript = renderTranscript(messages, resolved.maxTranscriptChars)
    if (transcript.trim().length === 0) return NO_HISTORY
    const prompt = buildReviewPrompt(
      resolved.prompt,
      resolved.context,
      invocation.rawInput.trim(),
      transcript,
      randomUUID(),
    )
    const promptBytes = Buffer.byteLength(prompt)
    if (promptBytes > resolved.maxPromptBytes) {
      return {
        kind: 'error',
        text: `The review prompt is ${promptBytes} bytes; the configured limit is ${resolved.maxPromptBytes} bytes.`,
      }
    }

    const owner = ensureOwner(owners, invocation.agent)
    const ownerStopped = (): boolean => owner.stopping
    /* v8 ignore next -- teardown unregisters the command; this guard only closes an in-flight dispatch race. */
    if (ownerStopped()) return { kind: 'error', text: 'Review owner is stopping.' }
    if (owner.active.size >= resolved.maxConcurrentReviews) {
      return {
        kind: 'error',
        text: `This agent already has ${owner.active.size} active review(s); the configured limit is ${resolved.maxConcurrentReviews}.`,
      }
    }

    const controller = new AbortController()
    const teardownController = new AbortController()
    const settlement = Promise.withResolvers<void>()
    let teardownDeadline: ReturnType<typeof deadline> | undefined
    const operation: ReviewOperation = {
      controller,
      teardownSignal: teardownController.signal,
      settled: settlement.promise,
      stop: () => {
        /* v8 ignore next -- Agent and plugin cleanup may converge on the same operation stop. */
        if (teardownDeadline === undefined) {
          const activeDeadline = deadline(undefined, resolved.teardownTimeoutMs, REVIEW_TEARDOWN_TIMEOUT)
          teardownDeadline = activeDeadline
          const abort = (): void => { teardownController.abort(activeDeadline.signal.reason) }
          activeDeadline.signal.addEventListener('abort', abort, { once: true })
        }
        controller.abort()
      },
      finish: () => { teardownDeadline?.[Symbol.dispose]() },
    }
    let operationSettled = false
    const settleOperation = (): void => {
      /* v8 ignore next -- spawn/admission paths and the background continuation may converge during teardown. */
      if (operationSettled) return
      operationSettled = true
      operation.finish()
      owner.active.delete(operation)
      settlement.resolve()
    }
    const failOperation = (error: unknown): void => {
      /* v8 ignore next -- a background rejection and owner teardown may converge on one operation. */
      if (operationSettled) return
      operationSettled = true
      operation.finish()
      operation.failure = error
      settlement.resolve()
    }
    owner.active.add(operation)

    const admissionSignal = AbortSignal.any([invocation.signal, controller.signal])
    let executable: string
    let commandInterpreter: string | undefined
    try {
      executable = await ctx.subprocess.resolveExecutable('codex', undefined, admissionSignal)
      if (codexNeedsCommandInterpreter(executable)) {
        commandInterpreter = await ctx.subprocess.resolveExecutable('cmd.exe', undefined, admissionSignal)
      }
    } catch (error: unknown) {
      settleOperation()
      if (invocation.signal.aborted) return CANCELLED
      if (controller.signal.aborted) return { kind: 'error', text: 'Review owner is stopping.' }
      return {
        kind: 'error',
        text: `The reviewer could not resolve the Codex CLI: ${renderThrown(error)}`,
      }
    }
    if (invocation.signal.aborted) {
      settleOperation()
      return CANCELLED
    }
    if (controller.signal.aborted) {
      settleOperation()
      return { kind: 'error', text: 'Review owner is stopping.' }
    }

    const commandId = invocation.commandId
    const launch = codexReviewLaunch({
      model: resolved.model,
      thinkingEffort: resolved.thinkingEffort,
      sandbox: resolved.sandbox,
    }, executable, commandInterpreter)
    const argv = launch.argv
    const cwd = invocation.agent.session.header.cwd ?? process.cwd()
    let start: SessionEvent<'review/start'>
    try {
      // The durable review lifecycle owns settlement from this point. Commit
      // immediately before its first append so a browser disconnect cannot
      // race the admitted background run into an error command/done.
      invocation.commit()
      start = appendReviewEvent(invocation.agent.session, 'review/start', {
        commandId,
        focus: invocation.rawInput.trim(),
        request: {
          prompt, argv, cwd, hostDeath: 'terminate', timeoutMs: resolved.timeoutMs,
          ...launch.env === undefined ? {} : { env: launch.env },
        },
      })
    } catch (error: unknown) {
      settleOperation()
      throw error
    }
    try {
      await flushReviewStart(ctx, invocation.agent.session, start, controller.signal)
    } catch (error: unknown) {
      const cancelled = ownerStopped()
      const text = cancelled
        ? renderCancelledReview([])
        : `The review could not persist its start: ${renderThrown(error)}`
      try {
        const terminal = appendReviewEvent(invocation.agent.session, 'review/end', {
          commandId, outcome: cancelled ? 'cancelled' : 'failed', text,
        })
        await flushReviewEnd(ctx, invocation.agent.session, terminal, operation.teardownSignal)
        settleOperation()
      } catch (terminalError: unknown) {
        const failure = new AggregateError(
          [error, terminalError],
          'command-reviewer: review/start durability and terminal publication failed',
        )
        ctx.logger.warn(`command-reviewer: ${cancelled ? 'cancelled' : 'failed'} review publication remains owned: ${renderThrown(failure)}`)
        failOperation(failure)
      }
      return { kind: 'success', sourceEventSeq: start.seq }
    }
    const reviewDeadline = deadline(controller.signal, resolved.timeoutMs, REVIEW_TIMEOUT)
    let handle: SubprocessHandle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: { data: prompt },
          stdout: 'pipe',
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        hostDeath: 'terminate',
        graceMs: resolved.subprocessGraceMs,
        signal: reviewDeadline.signal,
        ...launch.env === undefined ? {} : { env: launch.env },
      })
    } catch (error: unknown) {
      reviewDeadline[Symbol.dispose]()
      // A provider may request owner disposal reentrantly before throwing; its
      // cleanup abort is published in the next microtask.
      await Promise.resolve()
      const cancelled = ownerStopped()
      const text = cancelled
        ? renderCancelledReview([])
        : `The review could not start: ${renderThrown(error)}`
      try {
        const terminal = appendReviewEvent(invocation.agent.session, 'review/end', {
          commandId, outcome: cancelled ? 'cancelled' : 'failed', text,
        })
        await flushReviewEnd(ctx, invocation.agent.session, terminal, operation.teardownSignal)
        settleOperation()
      } catch (terminalError: unknown) {
        ctx.logger.warn(`command-reviewer: failed review publication remains owned: ${renderThrown(terminalError)}`)
        failOperation(terminalError)
      }
      return { kind: 'success', sourceEventSeq: start.seq }
    }

    const settled = runReview(
      ctx, handle, invocation.agent.session, commandId, resolved, reviewDeadline.signal,
      operation.teardownSignal,
    ).finally(() => { reviewDeadline[Symbol.dispose]() })
    // The admitted process follows its elapsed deadline and Agent owner, not
    // the browser Remote signal.
    void settled.then(settleOperation, (error: unknown) => {
      ctx.logger.warn(`command-reviewer: background review failed before process-tree exit: ${renderThrown(error)}`)
      failOperation(error)
    })
    return { kind: 'success', sourceEventSeq: start.seq }
  }

  ctx.effect(function* () {
    yield async () => {
      const cleanups = [...owners.values()].map(owner => Promise.resolve(owner.cleanup()))
      const results = await Promise.allSettled(cleanups)
      const failures: unknown[] = []
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'command-reviewer: subprocess cleanup failed before quiescence')
      }
      owners.clear()
    }
    yield ctx.commands.register({
      name: 'review',
      description: 'Review this conversation with the local Codex CLI (审查者)',
      input: { hint: '[optional review focus]' },
      recordInput: false,
      handler,
    })
  }, 'command-reviewer lifecycle')
}
