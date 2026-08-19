import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as invariant from '../src/invariant.ts'
import type {} from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(invariant)
  return ctx
}

describe('command-reviewer durable invariant', () => {
  it('accepts an unfinished prefix and a complete JSONL lifecycle', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const commandId = CommandId('review-1')
    session.append('review/start', { commandId, focus: '' })
    session.append('review/activity', {
      commandId, activityId: 'turn', kind: 'analysis', status: 'started',
    })
    session.append('review/activity', {
      commandId, activityId: 'turn', kind: 'analysis', status: 'completed',
    })
    // Codex can emit item.completed without an item.started record.
    session.append('review/activity', {
      commandId, activityId: 'message', kind: 'message', status: 'completed',
    })
    expect(() => session.append('review/end', {
      commandId, outcome: 'completed', text: 'review',
    })).not.toThrow()
    session.append('review/start', { commandId: CommandId('open'), focus: 'still running' })
    session.append('user/message', createUserMessage({
      content: [], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  })

  it('seeds an existing running review before validating its completion', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const commandId = CommandId('existing')
    session.append('review/start', { commandId, focus: 'resume' })
    session.append('review/activity', {
      commandId, activityId: 'command', kind: 'command', status: 'started', detail: 'pnpm test',
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(invariant)
    expect(() => session.append('review/activity', {
      commandId, activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm test',
    })).not.toThrow()
  })

  it.each([
    ['missing start', (session: Session) => session.append('review/end', {
      commandId: CommandId('missing'), outcome: 'failed', text: 'no start',
    }), /no matching review\/start/],
    ['duplicate start', (session: Session) => {
      const commandId = CommandId('duplicate')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/start', { commandId, focus: '' })
    }, /repeats command/],
    ['activity after end', (session: Session) => {
      const commandId = CommandId('closed')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/end', { commandId, outcome: 'cancelled', text: 'cancelled' })
      session.append('review/activity', { commandId, activityId: 'late', kind: 'other', status: 'started' })
    }, /appears after review\/end/],
    ['duplicate completion', (session: Session) => {
      const commandId = CommandId('activity')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'completed' })
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'completed' })
    }, /repeats completion/],
    ['invalid outcome', (session: Session) => {
      const commandId = CommandId('outcome')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/end', { commandId, outcome: 'unknown' as never, text: '' })
    }, /outcome unknown is invalid/],
    ['non-object data', (session: Session) => {
      session.append('review/start', null as never)
    }, /data must be a JSON object/],
    ['empty command id', (session: Session) => {
      session.append('review/start', { commandId: CommandId(''), focus: '' })
    }, /commandId must be a non-empty string/],
    ['invalid focus', (session: Session) => {
      session.append('review/start', { commandId: CommandId('focus'), focus: 1 as never })
    }, /focus must be a string/],
    ['invalid activity id', (session: Session) => {
      const commandId = CommandId('activity-id')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/activity', {
        commandId, activityId: '', kind: 'analysis', status: 'started',
      })
    }, /activityId must be a non-empty string/],
    ['invalid activity kind', (session: Session) => {
      const commandId = CommandId('activity-kind')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/activity', {
        commandId, activityId: 'one', kind: 'future' as never, status: 'started',
      })
    }, /kind future is invalid/],
    ['invalid activity status', (session: Session) => {
      const commandId = CommandId('activity-status')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/activity', {
        commandId, activityId: 'one', kind: 'analysis', status: 'pending' as never,
      })
    }, /status pending is invalid/],
    ['invalid activity detail', (session: Session) => {
      const commandId = CommandId('activity-detail')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/activity', {
        commandId, activityId: 'one', kind: 'analysis', status: 'started', detail: 1 as never,
      })
    }, /detail must be a string/],
    ['duplicate activity start', (session: Session) => {
      const commandId = CommandId('activity-start')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'started' })
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'started' })
    }, /repeats start/],
    ['invalid end text', (session: Session) => {
      const commandId = CommandId('end-text')
      session.append('review/start', { commandId, focus: '' })
      session.append('review/end', { commandId, outcome: 'failed', text: null as never })
    }, /text must be a string/],
  ] as const)('rejects %s before committing it', async (_label, mutate, pattern) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const before = session.seq
    let thrown: unknown
    try { mutate(session) } catch (error: unknown) { thrown = error }
    expect(thrown).toEqual(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT', packageName: '@deepseek-ai/dsh-command-reviewer',
    }))
    expect((thrown as Error).message).toMatch(pattern)
    expect(session.seq).toBeGreaterThanOrEqual(before)
  })
})
