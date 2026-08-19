/**
 * Human-facing `/review` command over the local Codex CLI. The command only
 * admits a review and returns a durable start acknowledgement; the owned
 * process then records Codex JSONL progress and its final result in the same
 * Session without entering the reviewed agent's model history.
 * @module @deepseek-ai/dsh-command-reviewer
 */

import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  buildReviewPrompt, codexReviewArgv, parseCodexJsonLine, renderTranscript,
  CODEX_MODEL_PATTERN, CODEX_SANDBOX_MODES, CODEX_THINKING_EFFORTS,
  type CodexSandbox, type CodexThinkingEffort,
} from './codex.ts'
import type { ReviewEndData, ReviewStartData } from './types.ts'
import type {} from './types.ts'

export {
  buildReviewPrompt, codexReviewArgv, parseCodexJsonLine, renderTranscript,
  CODEX_MODEL_PATTERN, CODEX_SANDBOX_MODES, CODEX_THINKING_EFFORTS, TRANSCRIPT_PLACEHOLDER,
} from './codex.ts'
export type { CodexJsonProgress, CodexReviewOptions, CodexSandbox, CodexThinkingEffort } from './codex.ts'
export type {
  ReviewActivityData, ReviewActivityKind, ReviewActivityStatus, ReviewEndData, ReviewOutcome, ReviewStartData,
} from './types.ts'

export const name = 'command-reviewer'

/** Required services: the human-command registry and the subprocess seam. */
export const inject = ['commands', 'subprocess']

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
/** Default complete JSONL output cap in bytes. */
const DEFAULT_MAX_OUTPUT_BYTES = 65_536
/** Default escalation grace in milliseconds for process-tree termination. */
const DEFAULT_TERMINATE_GRACE_MS = 3_000

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
  /** Complete Codex JSONL output cap in bytes. */
  maxOutputBytes?: number
  /** Escalation grace in milliseconds for process-tree termination. */
  terminateGraceMs?: number
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
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  terminateGraceMs: z.number().step(1).min(1).default(DEFAULT_TERMINATE_GRACE_MS),
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
const CODEX_MISSING: CommandResult = {
  kind: 'error',
  text: 'The Codex CLI is not available: codex was not found on PATH. Install @openai/codex and try again.',
}

function assertConfig(config: Required<Config>): void {
  if (config.terminateGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`command-reviewer: terminateGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function renderThrown(error: unknown): string {
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

function chunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  throw new Error('Codex stdout emitted a non-byte chunk')
}

interface ParsedOutput {
  readonly finalText?: string
  readonly failure?: string
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
  let finalText: string | undefined
  let failure: string | undefined

  const consume = (text: string): void => {
    carry += text
    const lines = carry.split('\n')
    /* v8 ignore next -- split() always returns at least one element. */
    carry = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const progress = parseCodexJsonLine(trimmed)
      if (progress.activity !== undefined) {
        appendReviewEvent(session, 'review/activity', {
          commandId,
          ...progress.activity,
        })
      }
      if (progress.finalText !== undefined) finalText = progress.finalText
      if (progress.failure !== undefined) failure = progress.failure
    }
  }

  if (handle.stdout === undefined) {
    const collected = handle.collected.stdout
    if (collected === undefined) throw new Error('Codex stdout pipe is unavailable')
    const bytesChunk = Buffer.from(collected.readFrom(0).text)
    bytes = bytesChunk.byteLength
    if (bytes > config.maxOutputBytes) {
      throw new Error(`Codex JSONL output exceeded configured limit of ${config.maxOutputBytes} bytes`)
    }
    consume(decoder.write(bytesChunk))
  } else {
    for await (const chunk of handle.stdout) {
      const bytesChunk = chunkBuffer(chunk)
      bytes += bytesChunk.byteLength
      if (bytes > config.maxOutputBytes) {
        throw new Error(`Codex JSONL output exceeded configured limit of ${config.maxOutputBytes} bytes`)
      }
      consume(decoder.write(bytesChunk))
    }
  }
  consume(`${decoder.end()}\n`)
  return {
    ...finalText === undefined ? {} : { finalText },
    ...failure === undefined ? {} : { failure },
  }
}

function exitFailure(handle: SubprocessHandle, outcome: SubprocessOutcome): string {
  if (outcome.exitCode === null && outcome.signal !== null) {
    return `The review failed: codex was terminated by ${outcome.signal}${stderrQuote(handle)}.`
  }
  return `The review failed: codex exited with code ${String(outcome.exitCode)}${stderrQuote(handle)}.`
}

interface ReviewOperation {
  readonly controller: AbortController
  readonly settled: Promise<void>
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
    for (const operation of owner.active) operation.controller.abort()
    await Promise.allSettled([...owner.active].map(operation => operation.settled))
    /* v8 ignore next -- this disposer belongs to the same owner stored for this Agent. */
    if (owners.get(agent) === owner) owners.delete(agent)
  }, 'command-reviewer.agent()')
  owners.set(agent, owner)
  return owner
}

async function runReview(
  ctx: Context,
  handle: SubprocessHandle,
  session: Session,
  commandId: ReviewStartData['commandId'],
  config: Required<Config>,
  signal: AbortSignal,
): Promise<void> {
  let output: ParsedOutput | undefined
  let failure: string | undefined
  let externallyCancelled = false
  let terminationRequested = false
  const terminate = (): void => {
    if (terminationRequested) return
    terminationRequested = true
    handle.terminate()
  }
  try {
    const outcomePromise = handle.done.then((outcome) => {
      if (!signal.aborted) terminate()
      return outcome
    })
    const [parsed, outcome] = await Promise.all([
      readJsonl(handle, config, session, commandId),
      outcomePromise,
    ])
    await handle.waitForExit()
    output = parsed
    if (signal.aborted) {
      externallyCancelled = true
    } else if (outcome.exitCode !== 0) {
      failure = exitFailure(handle, outcome)
    } else if (output.failure !== undefined) {
      failure = `The review failed: ${output.failure}`
    } else if (output.finalText === undefined || output.finalText.trim().length === 0) {
      failure = 'Codex completed without producing review output.'
    }
  } catch (error: unknown) {
    externallyCancelled = signal.aborted
    if (!externallyCancelled) {
      failure = renderThrown(error)
      terminate()
    }
    await Promise.allSettled([handle.done, handle.waitForExit()])
  }
  const completedText = output?.finalText?.trim() ?? ''
  const end: ReviewEndData = externallyCancelled
    ? { commandId, outcome: 'cancelled', text: 'Review cancelled because its owner stopped.' }
    : failure === undefined
      ? { commandId, outcome: 'completed', text: completedText }
      : { commandId, outcome: 'failed', text: failure }
  try {
    appendReviewEvent(session, 'review/end', end)
  } catch (error: unknown) {
    ctx.logger.warn(`command-reviewer: review/end append failed: ${renderThrown(error)}`)
  }
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
    )

    try {
      await ctx.subprocess.resolveExecutable('codex', undefined, invocation.signal)
    } catch {
      if (invocation.signal.aborted) return CANCELLED
      return CODEX_MISSING
    }
    if (invocation.signal.aborted) return CANCELLED

    const owner = ensureOwner(owners, invocation.agent)
    /* v8 ignore next -- teardown unregisters the command; this guard only closes an in-flight dispatch race. */
    if (owner.stopping) return { kind: 'error', text: 'Review owner is stopping.' }
    const commandId = invocation.commandId
    const controller = new AbortController()
    const settlement = Promise.withResolvers<void>()
    const operation: ReviewOperation = { controller, settled: settlement.promise }
    const settleOperation = (): void => {
      owner.active.delete(operation)
      settlement.resolve()
    }
    owner.active.add(operation)
    let start: SessionEvent<'review/start'>
    try {
      start = appendReviewEvent(invocation.agent.session, 'review/start', {
        commandId,
        focus: invocation.rawInput.trim(),
      })
    } catch (error: unknown) {
      settleOperation()
      throw error
    }
    let handle: SubprocessHandle
    try {
      handle = ctx.subprocess.spawn({
        argv: codexReviewArgv({
          model: resolved.model,
          thinkingEffort: resolved.thinkingEffort,
          sandbox: resolved.sandbox,
        }),
        cwd: invocation.agent.session.header.cwd ?? process.cwd(),
        stdio: {
          stdin: { data: prompt },
          stdout: 'pipe',
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: resolved.terminateGraceMs,
        signal: controller.signal,
      })
    } catch (error: unknown) {
      const text = `The review could not start: ${renderThrown(error)}`
      try {
        appendReviewEvent(invocation.agent.session, 'review/end', {
          commandId, outcome: 'failed', text,
        })
      } catch (appendError: unknown) {
        ctx.logger.warn(`command-reviewer: review/end append failed: ${renderThrown(appendError)}`)
      }
      settleOperation()
      return { kind: 'success', sourceEventSeq: start.seq }
    }

    const settled = runReview(ctx, handle, invocation.agent.session, commandId, resolved, controller.signal)
    // The process deliberately uses this owner controller rather than the
    // browser Remote signal. It can only be triggered by agent/plugin teardown.
    void settled.then(settleOperation, settleOperation)
    return { kind: 'success', sourceEventSeq: start.seq }
  }

  ctx.effect(function* () {
    yield async () => {
      const cleanups = [...owners.values()].map(owner => Promise.resolve(owner.cleanup()))
      await Promise.allSettled(cleanups)
      owners.clear()
    }
    yield ctx.commands.register({
      name: 'review',
      description: 'Review this conversation with the local Codex CLI (审查者)',
      input: { hint: '[optional review focus]' },
      handler,
    })
  }, 'command-reviewer lifecycle')
}
