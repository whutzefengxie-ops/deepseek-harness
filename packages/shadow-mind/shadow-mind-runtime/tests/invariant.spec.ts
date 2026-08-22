import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ShadowInvariant from '../src/invariant.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ShadowInvariant)
  return ctx
}

function relay(reports: unknown[]): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: 1,
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text: 'report' }],
      source: { kind: 'shadow-report', form: 'relay', reports } as never,
    }),
  }
}

describe('Shadow Mind relay invariant', () => {
  it('accepts unrelated events and valid report provenance', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('shadow-invariant-valid'))
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', session, relay([{
        shadowId: 'reviewer',
        runId: 'run-1',
        childSessionId: SessionId('child-1'),
        capturedThroughSeq: 0,
      }]))
    }).not.toThrow()
  })

  it.each([
    [[], /at least one report/],
    [[{ shadowId: '', runId: 'run-1', childSessionId: 'child-1', capturedThroughSeq: 0 }], /ids must be non-empty/],
    [[
      { shadowId: 'a', runId: 'same', childSessionId: 'child-a', capturedThroughSeq: 0 },
      { shadowId: 'b', runId: 'same', childSessionId: 'child-b', capturedThroughSeq: 0 },
    ], /repeats run id/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: -1 }], /must precede/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 1.5 }], /must precede/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 1 }], /must precede/],
  ])('rejects malformed provenance %#', async (reports, message) => {
    const ctx = await setup()
    expect(() => {
      ctx.emit(
        'session/event',
        Session.create(SessionId(`shadow-invariant-invalid-${String(reports.length)}`)),
        relay(reports),
      )
    }).toThrow(message)
  })
})
