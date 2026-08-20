/** Durable lifecycle invariant for `@deepseek-ai/dsh-command-reviewer`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-reviewer'

/** Cordis companion plugin name. */
export const name = 'command-reviewer-invariant'
/** Services required to validate existing and newly appended Session logs. */
export const inject = ['invariants']

interface ReviewTrace {
  readonly startSeq: number
  ended: boolean
  readonly activities: Map<string, 'started' | 'completed'>
}

interface CommandTrace {
  readonly name: unknown
  readonly args: unknown
  readonly runSeq: number
  doneSeq?: number
}

interface Trace {
  readonly commands: Map<string, CommandTrace>
  readonly reviews: Map<string, ReviewTrace>
}

function owned(event: SessionEvent): boolean {
  return event.type === 'review/start' || event.type === 'review/activity' || event.type === 'review/end'
}

function relevant(event: SessionEvent): boolean {
  return owned(event) || event.type === 'command/run' || event.type === 'command/done'
}

function record(event: SessionEvent, fail: InvariantFailure): Record<string, unknown> {
  const data: unknown = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${event.type} data must be a JSON object`)
  }
  return { ...data }
}

function id(data: Record<string, unknown>, eventType: string, fail: InvariantFailure): string {
  if (typeof data.commandId !== 'string' || data.commandId.length === 0) {
    fail(`${eventType} commandId must be a non-empty string`)
  }
  return data.commandId
}

function open(trace: Trace, commandId: string, eventType: string, fail: InvariantFailure): ReviewTrace {
  const review = trace.reviews.get(commandId)
  if (review === undefined) fail(`${eventType} has no matching review/start for command ${commandId}`)
  if (review.ended) fail(`${eventType} appears after review/end for command ${commandId}`)
  return review
}

function request(data: Record<string, unknown>, fail: InvariantFailure): void {
  if (data.request === null || typeof data.request !== 'object' || Array.isArray(data.request)) {
    fail('review/start request must be a JSON object')
  }
  const value = { ...data.request } as Record<string, unknown>
  if (typeof value.prompt !== 'string' || value.prompt.length === 0) {
    fail('review/start request prompt must be a non-empty string')
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0
    || value.argv.some(argument => typeof argument !== 'string' || argument.length === 0)) {
    fail('review/start request argv must be a non-empty string array')
  }
  if (value.env !== undefined && (value.env === null || typeof value.env !== 'object' || Array.isArray(value.env)
    || Object.entries(value.env as Record<string, unknown>)
      .some(([key, entry]) => key.length === 0 || typeof entry !== 'string'))) {
    fail('review/start request env must contain non-empty keys with string values when present')
  }
  if (typeof value.cwd !== 'string' || value.cwd.length === 0) {
    fail('review/start request cwd must be a non-empty string')
  }
  if (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) <= 0) {
    fail('review/start request timeoutMs must be a positive safe integer')
  }
}

function commandEvent(trace: Trace, event: SessionEvent, fail: InvariantFailure): boolean {
  if (event.type === 'command/run') {
    const raw: unknown = event.data
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return true
    const data = { ...raw } as Record<string, unknown>
    if (data.name !== 'review') return true
    const commandId = id(data, event.type, fail)
    trace.commands.set(commandId, {
      name: data.name,
      args: data.args,
      runSeq: event.seq,
    })
    return true
  }
  if (event.type !== 'command/done') return false
  const raw: unknown = event.data
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return true
  const data = { ...raw } as Record<string, unknown>
  if (typeof data.commandId !== 'string') return true
  const commandId = data.commandId
  const command = trace.commands.get(commandId)
  if (command?.name !== 'review') return true
  command.doneSeq = event.seq
  const review = trace.reviews.get(commandId)
  if (review === undefined) {
    if (data.sourceEventSeq !== undefined) {
      fail(`command/done for review ${commandId} points to no matching review/start`)
    }
    return true
  }
  if (data.kind !== 'success' || data.sourceEventSeq !== review.startSeq) {
    fail(`command/done for review ${commandId} must succeed and point to review/start ${review.startSeq}`)
  }
  return true
}

function applyEvent(trace: Trace, event: SessionEvent, fail: InvariantFailure): void {
  if (commandEvent(trace, event, fail)) return
  const data = record(event, fail)
  const commandId = id(data, event.type, fail)
  switch (event.type) {
    case 'review/start': {
      if (typeof data.focus !== 'string') fail('review/start focus must be a string')
      request(data, fail)
      if (trace.reviews.has(commandId)) fail(`review/start repeats command ${commandId}`)
      const command = trace.commands.get(commandId)
      if (command === undefined || command.name !== 'review' || command.runSeq >= event.seq) {
        fail(`review/start has no prior /review command/run for command ${commandId}`)
      }
      if (typeof command.args !== 'string' || command.args.trim() !== data.focus) {
        fail(`review/start focus does not match command/run args for command ${commandId}`)
      }
      if (command.doneSeq !== undefined) fail(`review/start appears after command/done for command ${commandId}`)
      trace.reviews.set(commandId, { startSeq: event.seq, ended: false, activities: new Map() })
      return
    }
    case 'review/activity': {
      const review = open(trace, commandId, event.type, fail)
      if (typeof data.activityId !== 'string' || data.activityId.length === 0) {
        fail('review/activity activityId must be a non-empty string')
      }
      if (!['analysis', 'command', 'tool', 'web-search', 'file-change', 'message', 'other'].includes(String(data.kind))) {
        fail(`review/activity kind ${String(data.kind)} is invalid`)
      }
      if (data.status !== 'started' && data.status !== 'completed') {
        fail(`review/activity status ${String(data.status)} is invalid`)
      }
      if (data.detail !== undefined && typeof data.detail !== 'string') {
        fail('review/activity detail must be a string when present')
      }
      const activityId = data.activityId
      const previous = review.activities.get(activityId)
      if (data.status === 'started') {
        if (previous !== undefined) fail(`review/activity repeats start for ${activityId}`)
        review.activities.set(activityId, 'started')
      } else {
        if (previous === 'completed') fail(`review/activity repeats completion for ${activityId}`)
        review.activities.set(activityId, 'completed')
      }
      return
    }
    case 'review/end': {
      const review = open(trace, commandId, event.type, fail)
      if (data.outcome !== 'completed' && data.outcome !== 'failed'
        && data.outcome !== 'cancelled' && data.outcome !== 'interrupted') {
        fail(`review/end outcome ${String(data.outcome)} is invalid`)
      }
      if (typeof data.text !== 'string') fail('review/end text must be a string')
      review.ended = true
      return
    }
    /* v8 ignore next -- owned() admits only the three reviewer event variants handled above. */
    default:
      fail(`unknown reviewer event ${event.type}`)
  }
}

/** Install an incremental fold over every attached Session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, Trace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: Trace }>()

  const seed = (session: Session): Trace => {
    const trace: Trace = { commands: new Map(), reviews: new Map() }
    for (const event of session.events.filter(relevant)) applyEvent(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  ctx.sessions.list().forEach(seed)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!relevant(event)) return
    const source = traces.get(session)
    /* v8 ignore next -- SessionStore emits session/created before a Session can append events. */
    if (source === undefined) return fail('review session/event arrived before session seeding')
    const trace: Trace = {
      commands: new Map(source.commands),
      reviews: new Map(source.reviews),
    }
    const review = event.type === 'review/activity' || event.type === 'review/end'
      ? record(event, fail).commandId
      : undefined
    if (review !== undefined) {
      const current = source.reviews.get(review as string)
      if (current !== undefined) trace.reviews.set(review as string, {
        startSeq: current.startSeq,
        ended: current.ended,
        activities: new Map(current.activities),
      })
    }
    if (event.type === 'command/done') {
      const data: unknown = event.data
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const commandId = (data as Record<string, unknown>).commandId
        const current = typeof commandId === 'string' ? source.commands.get(commandId) : undefined
        if (current !== undefined) trace.commands.set(commandId as string, { ...current })
      }
    }
    applyEvent(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!relevant(event)) return
    const candidate = staged.get(event)
    /* v8 ignore next 3 -- internal/dispatch stages every package-owned event before publication. */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without reviewer validation')
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
