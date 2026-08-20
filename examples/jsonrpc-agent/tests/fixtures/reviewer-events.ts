/** Keyless SDK snapshot fixture that emits one complete reviewer lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-command-reviewer/types'

/** Cordis plugin name. */
export const name = 'reviewer-events-fixture'

/** Emit one complete, reconstructable reviewer lifecycle per Agent. */
export function apply(ctx: Context): void {
  const emitted = new WeakSet<Agent>()
  ctx.on('agent/request', ({ agent }, next) => {
    if (emitted.has(agent)) return next()
    emitted.add(agent)
    const commandId = CommandId('sdk-snapshot-review')
    agent.session.append('command/run', {
      commandId, name: 'review', args: ' inspect the SDK event projection', source: { kind: 'user' },
    })
    const start = agent.session.append('review/start', {
      commandId,
      focus: 'inspect the SDK event projection',
      request: {
        prompt: 'Inspect the SDK event projection.',
        argv: ['/snapshot/codex', 'exec', '--json'],
        cwd: '/snapshot/workspace',
        timeoutMs: 1_800_000,
      },
    })
    agent.session.append('command/done', { commandId, kind: 'success', sourceEventSeq: start.seq })
    agent.session.append('review/activity', {
      commandId, activityId: 'turn', kind: 'analysis', status: 'completed',
    })
    agent.session.append('review/end', {
      commandId, outcome: 'completed', text: 'SDK reviewer projection complete.',
    })
    return next()
  })
}
