import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as invariant from '../src/invariant.ts'
import type {} from '../src/types.ts'

const REQUEST = {
  prompt: 'Review this transcript.',
  argv: ['/resolved/codex', 'exec', '--json'],
  cwd: '/workspace',
  timeoutMs: 1_800_000,
} as const

function appendStart(session: Session, commandId: CommandId, focus = ''): number {
  session.append('command/run', {
    commandId, name: 'review', args: focus.length === 0 ? '' : ` ${focus}`, source: { kind: 'user' },
  })
  return session.append('review/start', { commandId, focus, request: REQUEST }).seq
}

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
    const startSeq = appendStart(session, commandId)
    session.append('command/done', { commandId, kind: 'success', sourceEventSeq: startSeq })
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
    appendStart(session, CommandId('open'), 'still running')
    session.append('user/message', createUserMessage({
      content: [], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  })

  it('seeds an existing running review before validating its completion', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const commandId = CommandId('existing')
    const startSeq = appendStart(session, commandId, 'resume')
    session.append('command/done', { commandId, kind: 'success', sourceEventSeq: startSeq })
    session.append('review/activity', {
      commandId, activityId: 'command', kind: 'command', status: 'started', detail: 'pnpm test',
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(invariant)
    expect(() => session.append('review/activity', {
      commandId, activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm test',
    })).not.toThrow()
  })

  it('ignores malformed or unrelated command events owned by the command invariant', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('command/run', null as never)
      session.append('command/run', { commandId: CommandId('other'), name: 'compact', source: { kind: 'user' } })
      session.append('command/done', null as never)
      session.append('command/done', { commandId: 1 as never, kind: 'error', text: 'invalid elsewhere' })
      session.append('command/done', { commandId: CommandId('unknown'), kind: 'error', text: 'unknown elsewhere' })
    }).not.toThrow()
  })

  it.each([
    ['no command/run', (session: Session) => {
      session.append('review/start', { commandId: CommandId('missing-run'), focus: '', request: REQUEST })
    }, /no prior \/review command\/run/],
    ['wrong command', (session: Session) => {
      const commandId = CommandId('wrong-command')
      session.append('command/run', { commandId, name: 'compact', args: '', source: { kind: 'user' } })
      session.append('review/start', { commandId, focus: '', request: REQUEST })
    }, /no prior \/review command\/run/],
    ['focus mismatch', (session: Session) => {
      const commandId = CommandId('focus-mismatch')
      session.append('command/run', { commandId, name: 'review', args: ' expected', source: { kind: 'user' } })
      session.append('review/start', { commandId, focus: 'different', request: REQUEST })
    }, /focus does not match/],
    ['wrong done source', (session: Session) => {
      const commandId = CommandId('wrong-source')
      appendStart(session, commandId)
      session.append('command/done', { commandId, kind: 'success', sourceEventSeq: 0 })
    }, /must succeed and point to review\/start/],
    ['failed done after start', (session: Session) => {
      const commandId = CommandId('failed-done')
      appendStart(session, commandId)
      session.append('command/done', { commandId, kind: 'error', text: 'failed' })
    }, /must succeed and point to review\/start/],
    ['domain source without start', (session: Session) => {
      const commandId = CommandId('source-without-start')
      session.append('command/run', { commandId, name: 'review', args: '', source: { kind: 'user' } })
      const source = session.append('turn/start', { turn: 1 })
      session.append('command/done', { commandId, kind: 'success', sourceEventSeq: source.seq })
    }, /points to no matching review\/start/],
    ['start after done', (session: Session) => {
      const commandId = CommandId('start-after-done')
      session.append('command/run', { commandId, name: 'review', args: '', source: { kind: 'user' } })
      session.append('command/done', { commandId, kind: 'error', text: 'failed' })
      session.append('review/start', { commandId, focus: '', request: REQUEST })
    }, /appears after command\/done/],
  ] as const)('rejects a broken cross-event relation: %s', async (_label, mutate, pattern) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => { mutate(session) }).toThrow(pattern)
  })

  it.each([
    [null, /request must be a JSON object/],
    [{ ...REQUEST, prompt: '' }, /prompt must be a non-empty string/],
    [{ ...REQUEST, argv: [] }, /argv must be a non-empty string array/],
    [{ ...REQUEST, argv: ['/codex', ''] }, /argv must be a non-empty string array/],
    [{ ...REQUEST, env: null }, /env must contain non-empty keys with string values/],
    [{ ...REQUEST, env: { '': 'value' } }, /env must contain non-empty keys with string values/],
    [{ ...REQUEST, env: { DSH_CODEX_REVIEWER_EXECUTABLE: 1 } }, /env must contain non-empty keys with string values/],
    [{ ...REQUEST, cwd: '' }, /cwd must be a non-empty string/],
    [{ ...REQUEST, timeoutMs: 0 }, /timeoutMs must be a positive safe integer/],
    [{ ...REQUEST, timeoutMs: 1.5 }, /timeoutMs must be a positive safe integer/],
  ] as const)('rejects an invalid persisted request %#', async (value, pattern) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const commandId = CommandId('bad-request')
    session.append('command/run', { commandId, name: 'review', args: '', source: { kind: 'user' } })
    expect(() => session.append('review/start', {
      commandId, focus: '', request: value as never,
    })).toThrow(pattern)
  })

  it.each([
    ['missing start', (session: Session) => session.append('review/end', {
      commandId: CommandId('missing'), outcome: 'failed', text: 'no start',
    }), /no matching review\/start/],
    ['duplicate start', (session: Session) => {
      const commandId = CommandId('duplicate')
      appendStart(session, commandId)
      session.append('review/start', { commandId, focus: '', request: REQUEST })
    }, /repeats command/],
    ['activity after end', (session: Session) => {
      const commandId = CommandId('closed')
      appendStart(session, commandId)
      session.append('review/end', { commandId, outcome: 'cancelled', text: 'cancelled' })
      session.append('review/activity', { commandId, activityId: 'late', kind: 'other', status: 'started' })
    }, /appears after review\/end/],
    ['duplicate completion', (session: Session) => {
      const commandId = CommandId('activity')
      appendStart(session, commandId)
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'completed' })
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'completed' })
    }, /repeats completion/],
    ['invalid outcome', (session: Session) => {
      const commandId = CommandId('outcome')
      appendStart(session, commandId)
      session.append('review/end', { commandId, outcome: 'unknown' as never, text: '' })
    }, /outcome unknown is invalid/],
    ['non-object data', (session: Session) => {
      session.append('review/start', null as never)
    }, /data must be a JSON object/],
    ['empty command id', (session: Session) => {
      appendStart(session, CommandId(''))
    }, /commandId must be a non-empty string/],
    ['invalid focus', (session: Session) => {
      const commandId = CommandId('focus')
      session.append('command/run', { commandId, name: 'review', args: '', source: { kind: 'user' } })
      session.append('review/start', { commandId, focus: 1 as never, request: REQUEST })
    }, /focus must be a string/],
    ['invalid activity id', (session: Session) => {
      const commandId = CommandId('activity-id')
      appendStart(session, commandId)
      session.append('review/activity', {
        commandId, activityId: '', kind: 'analysis', status: 'started',
      })
    }, /activityId must be a non-empty string/],
    ['invalid activity kind', (session: Session) => {
      const commandId = CommandId('activity-kind')
      appendStart(session, commandId)
      session.append('review/activity', {
        commandId, activityId: 'one', kind: 'future' as never, status: 'started',
      })
    }, /kind future is invalid/],
    ['invalid activity status', (session: Session) => {
      const commandId = CommandId('activity-status')
      appendStart(session, commandId)
      session.append('review/activity', {
        commandId, activityId: 'one', kind: 'analysis', status: 'pending' as never,
      })
    }, /status pending is invalid/],
    ['invalid activity detail', (session: Session) => {
      const commandId = CommandId('activity-detail')
      appendStart(session, commandId)
      session.append('review/activity', {
        commandId, activityId: 'one', kind: 'analysis', status: 'started', detail: 1 as never,
      })
    }, /detail must be a string/],
    ['duplicate activity start', (session: Session) => {
      const commandId = CommandId('activity-start')
      appendStart(session, commandId)
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'started' })
      session.append('review/activity', { commandId, activityId: 'one', kind: 'tool', status: 'started' })
    }, /repeats start/],
    ['invalid end text', (session: Session) => {
      const commandId = CommandId('end-text')
      appendStart(session, commandId)
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
