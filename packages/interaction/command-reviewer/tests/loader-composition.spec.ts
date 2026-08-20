import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import * as commandReviewer from '../src/index.ts'

/** The smallest subprocess provider the Loader composition needs. */
class LoaderSubprocess extends SubprocessRuntime {
  spawns: SubprocessSpawnSpec[] = []

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(`/loader/${command}`)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const outcome: SubprocessOutcome = { exitCode: 0, signal: null }
    return {
      pid: 7,
      stdin: undefined,
      stdout: Readable.from([`${JSON.stringify({
        type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'Loader review text.' },
      })}\n`]),
      stderr: undefined,
      collected: {
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve(outcome),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('not used')
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('command-reviewer real Loader composition', () => {
  it('discovers and executes /review through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-reviewer-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'sessions'))}`,
      '    compression: none',
      '    writeBatchMaxDelayMs: 1',
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@test/reviewer-subprocess'",
      "- name: '@deepseek-ai/dsh-command-reviewer'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@test/reviewer-subprocess', LoaderSubprocess],
      ['@deepseek-ai/dsh-command-reviewer', commandReviewer],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = context.sessions.create(SessionId('loader-command-reviewer'), {
      meta: { cwd: root },
    })
    session.append('user/message', createMessage({
      role: 'user',
      content: [{ type: 'text', text: 'fix the loader' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = {
      id: session.id,
      ctx: context,
      session,
      status: 'idle',
      options: {},
      reserveTurnAdmission: () => () => undefined,
    } as unknown as Agent
    expect(context.commands.list(agent)).toContainEqual({
      name: 'review',
      description: 'Review this conversation with the local Codex CLI (审查者)',
      input: { hint: '[optional review focus]' },
    })
    const execution = await context.commands.execute(agent, '/review', [], new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /review')
    const start = session.events.find(event => event.type === 'review/start')
    expect(execution.result).toEqual({ kind: 'success', sourceEventSeq: start?.seq })
    await expect.poll(() => session.events.some(event => event.type === 'review/end')).toBe(true)

    const subprocess = context.subprocess as unknown as LoaderSubprocess
    const [spec] = subprocess.spawns
    if (spec === undefined) throw new Error('no spawn recorded')
    expect(spec.cwd).toBe(root)
    expect(spec.argv[0]).toBe('/loader/codex')
    if (typeof spec.stdio.stdin !== 'object') throw new Error('expected batch stdin')
    expect(spec.stdio.stdin.data).toContain('User: fix the loader')
    if (start?.type !== 'review/start') throw new Error('review/start missing')
    expect(start.data.request).toEqual({
      prompt: spec.stdio.stdin.data,
      argv: spec.argv,
      cwd: root,
      timeoutMs: 3_600_000,
    })

    expect(session.events.filter(event => event.type === 'command/run' || event.type === 'command/done')
      .map(event => event.type)).toEqual(['command/run', 'command/done'])
    const run = session.events.find(event => event.type === 'command/run')
    expect(run?.type === 'command/run' && Object.hasOwn(run.data, 'args')).toBe(false)
    expect(session.events.filter(event => event.type.startsWith('review/')).map(event => event.type))
      .toEqual(['review/start', 'review/activity', 'review/end'])
    await expect(context.sessionPersistence.inspect(session.id)).resolves.toMatchObject({
      events: session.events,
    })
    // The command lifecycle pair is log-only: derived history still holds only
    // the seeded user message.
    expect(session.deriveMessages()).toHaveLength(1)
  })
})
