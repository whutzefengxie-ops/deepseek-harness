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

function relay(reports: unknown[], seq = 1): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
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
        verdict: 'challenge',
        refs: [],
      }]))
    }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', session, relay([{
        shadowId: 'synthesizer',
        runId: 'run-synthesis',
        childSessionId: SessionId('child-synthesis'),
        capturedThroughSeq: 2,
        verdict: 'confirm',
        refs: [1, 2],
        replacesRunIds: ['run-left', 'run-right'],
      }], 3))
    }).not.toThrow()
  })

  it.each([
    [[], /at least one report/],
    [[{ shadowId: '', runId: 'run-1', childSessionId: 'child-1', capturedThroughSeq: 0, verdict: 'challenge' }], /ids must be non-empty/],
    [[
      { shadowId: 'a', runId: 'same', childSessionId: 'child-a', capturedThroughSeq: 0, verdict: 'challenge' },
      { shadowId: 'b', runId: 'same', childSessionId: 'child-b', capturedThroughSeq: 0, verdict: 'confirm' },
    ], /repeats run id/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: -1, verdict: 'challenge' }], /must precede/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 1.5, verdict: 'challenge' }], /must precede/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 1, verdict: 'challenge' }], /must precede/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 0, verdict: 'unknown' }], /known verdict/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 0, verdict: 'challenge', severity: 2 }], /severity/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 0, verdict: 'challenge', refs: [1] }], /refs/],
    [[{ shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 1, verdict: 'challenge', refs: [2] }], /capture watermark/, 3],
    [[{
      shadowId: 'a', runId: 'run-a', childSessionId: 'child-a', capturedThroughSeq: 0,
      verdict: 'challenge', replacesRunIds: ['run-left'],
    }], /replace two distinct/],
  ])('rejects malformed provenance %#', async (reports, message, seq = 1) => {
    const ctx = await setup()
    expect(() => {
      ctx.emit(
        'session/event',
        Session.create(SessionId(`shadow-invariant-invalid-${String(reports.length)}`)),
        relay(reports, seq),
      )
    }).toThrow(message)
  })
})
