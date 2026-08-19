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
  ended: boolean
  readonly activities: Map<string, 'started' | 'completed'>
}

type ReviewTraces = Map<string, ReviewTrace>

function owned(event: SessionEvent): boolean {
  return event.type === 'review/start' || event.type === 'review/activity' || event.type === 'review/end'
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

function open(trace: ReviewTraces, commandId: string, eventType: string, fail: InvariantFailure): ReviewTrace {
  const review = trace.get(commandId)
  if (review === undefined) fail(`${eventType} has no matching review/start for command ${commandId}`)
  if (review.ended) fail(`${eventType} appears after review/end for command ${commandId}`)
  return review
}

function applyEvent(trace: ReviewTraces, event: SessionEvent, fail: InvariantFailure): void {
  const data = record(event, fail)
  const commandId = id(data, event.type, fail)
  switch (event.type) {
    case 'review/start':
      if (typeof data.focus !== 'string') fail('review/start focus must be a string')
      if (trace.has(commandId)) fail(`review/start repeats command ${commandId}`)
      trace.set(commandId, { ended: false, activities: new Map() })
      return
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
      if (data.outcome !== 'completed' && data.outcome !== 'failed' && data.outcome !== 'cancelled') {
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
  const traces = new WeakMap<Session, ReviewTraces>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: ReviewTraces }>()

  const seed = (session: Session): ReviewTraces => {
    const trace: ReviewTraces = new Map()
    for (const event of session.events.filter(owned)) applyEvent(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  ctx.sessions.list().forEach(seed)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!owned(event)) return
    const source = traces.get(session)
    /* v8 ignore next -- SessionStore emits session/created before a Session can append events. */
    if (source === undefined) return fail('review session/event arrived before session seeding')
    const trace = new Map(source)
    const review = event.type === 'review/start' ? undefined : record(event, fail).commandId
    if (review !== undefined) {
      const current = source.get(review as string)
      if (current !== undefined) trace.set(review as string, {
        ended: current.ended,
        activities: new Map(current.activities),
      })
    }
    applyEvent(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!owned(event)) return
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
