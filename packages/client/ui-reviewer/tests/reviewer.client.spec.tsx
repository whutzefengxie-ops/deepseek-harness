// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode, ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ReviewerPanel } from '../src/client/ReviewerPanel.tsx'
import { apply as applyClient, inject as clientInject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { reviewerDefinition, type ReviewerChatData } from '../src/client/reviewer-definition.ts'
import { apply as applyNode, inject as nodeInject, name as nodeName } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

afterEach(cleanup)

interface Snapshot { readonly nodes: ReadonlyMap<string, ChatConversationViewNode> }
class Events {
  entries(): readonly ConversationNodeDefinition[] { return [reviewerDefinition] }
  fallbackEntry(): undefined { return undefined }
}
class Views { entries(): readonly ConversationViewDefinition[] { return [chat] } }
const chat: ConversationViewDefinition<ChatConversationViewNode, Snapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): Snapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: (input) => { nodes = new Map(input.nodes.map(node => [node.key, node])); return snapshot() },
      apply: (input) => { nodes = new Map(nodes); input.upserts.forEach(node => nodes.set(node.key, node)); return snapshot() },
    }
  },
}
function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq, type, data } as ConversationEventInput['event'], view: undefined }
}
function assemble(events: ConversationEventInput[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new Events(), new Views())
  value.replaceWindow(events, false)
  value.flush()
  return value
}
function data(value: ConversationNodeAssembler): ReviewerChatData | undefined {
  return [...(value.snapshot('chat') as Snapshot).nodes.values()][0]?.data as ReviewerChatData | undefined
}

function panelProps(panelData: ReviewerChatData): Parameters<typeof ReviewerPanel>[0] {
  return {
    node: { data: panelData },
    t: makeTranslate(zh),
  } as unknown as Parameters<typeof ReviewerPanel>[0]
}

function match(seq: number, type: string, eventData: unknown) {
  return {
    ...at(seq, type, eventData),
    role: 'update' as const,
    location: { kind: 'unresolved' as const },
  }
}

describe('reviewer durable Conversation Definition', () => {
  const lifecycle = [
    at(1, 'review/start', { commandId: 'cmd-1', focus: '只看并发' }),
    at(2, 'review/activity', { commandId: 'cmd-1', activityId: 'turn', kind: 'analysis', status: 'started' }),
    at(3, 'review/activity', { commandId: 'cmd-1', activityId: 'command', kind: 'command', status: 'started', detail: 'pnpm test' }),
    at(4, 'review/activity', { commandId: 'cmd-1', activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm test' }),
    at(5, 'review/end', { commandId: 'cmd-1', outcome: 'completed', text: '## 结论\n\n发现一个问题。' }),
  ]

  it('replays and live-folds progress into the same completed card', () => {
    const replay = assemble(lifecycle)
    expect(data(replay)).toEqual({
      focus: '只看并发', status: 'completed',
      activities: [
        { activityId: 'turn', kind: 'analysis', status: 'started' },
        { activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm test' },
      ],
      text: '## 结论\n\n发现一个问题。',
    })
    const live = assemble(lifecycle.slice(0, 1))
    lifecycle.slice(1).forEach(event => live.append(event))
    live.flush()
    expect(data(live)).toEqual(data(replay))
  })

  it.each(['failed', 'cancelled'] as const)('restores a %s result after refresh', (outcome) => {
    expect(data(assemble([
      lifecycle[0]!,
      at(2, 'review/end', { commandId: 'cmd-1', outcome, text: `${outcome} details` }),
    ]))).toMatchObject({ status: outcome, text: `${outcome} details` })
  })

  it('restores a paged terminal card before review/start is loaded', () => {
    const value = assemble([
      at(8, 'review/activity', {
        commandId: 'cmd-1', activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm test',
      }),
      at(9, 'review/end', { commandId: 'cmd-1', outcome: 'completed', text: 'Paged result.' }),
    ])
    expect(data(value)).toEqual({
      focus: '',
      status: 'completed',
      activities: [{ activityId: 'command', kind: 'command', status: 'completed', detail: 'pnpm test' }],
      text: 'Paged result.',
    })

    value.prepend([at(1, 'review/start', { commandId: 'cmd-1', focus: '审查并发' })], false)
    value.flush()
    expect(data(value)).toMatchObject({ focus: '审查并发', status: 'completed', text: 'Paged result.' })
  })

  it('ignores unrelated events and rejects an invalid direct start call', () => {
    expect(reviewerDefinition.match(at(1, 'turn/start', { turn: 1 }).event)).toBeNull()
    const invalid = match(1, 'review/activity', {
      commandId: 'cmd-1', activityId: 'a', kind: 'analysis', status: 'started',
    })
    const context = {
      key: 'reviewer:cmd-1', kind: 'reviewer', id: 'cmd-1',
      matches: [invalid], start: invalid, state: undefined, current: new Map(),
    }
    expect(() => reviewerDefinition.start(context, invalid, { previous: () => undefined }))
      .toThrow('reviewer start requires review/start')
  })

  it('keeps state for an unrelated direct update and withholds an empty view context', () => {
    const start = match(1, 'review/start', { commandId: 'cmd-1', focus: '' })
    const state = {
      commandId: 'cmd-1' as never, focus: '', status: 'running' as const, activities: [],
    }
    const unrelated = match(2, 'turn/start', { turn: 1 })
    const complete = {
      key: 'reviewer:cmd-1', kind: 'reviewer', id: 'cmd-1', matches: [start, unrelated],
      start, state, current: new Map(),
    }
    expect(reviewerDefinition.update(complete, unrelated)).toBe(state)
    expect(reviewerDefinition.buildViewNode?.({ ...complete, start: undefined, matches: [], state: undefined })).toBeNull()
    expect(reviewerDefinition.buildViewNode?.({ ...complete, state: undefined })).toMatchObject({
      data: { focus: '', status: 'running', activities: [] },
    })
  })
})

describe('ReviewerPanel', () => {
  it('shows real activity, status, focus, and final Markdown', () => {
    const node = {
      key: 'reviewer:cmd-1', kind: 'reviewer', id: 'cmd-1', target: 'chat', anchorSeq: 1,
      location: { kind: 'unresolved' }, visibility: 'visible',
      data: data(assemble([
        at(1, 'review/start', { commandId: 'cmd-1', focus: '审查代码' }),
        at(2, 'review/activity', { commandId: 'cmd-1', activityId: 'c1', kind: 'command', status: 'completed', detail: 'git diff' }),
        at(3, 'review/end', { commandId: 'cmd-1', outcome: 'completed', text: '**没有阻塞问题**' }),
      ]))!,
    }
    const props = { node, t: makeTranslate(zh) } as unknown as Parameters<typeof ReviewerPanel>[0]
    const view = render(<ReviewerPanel {...props} />)
    expect(screen.getByText('审查代码')).toBeTruthy()
    expect(screen.getByText('git diff')).toBeTruthy()
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText('没有阻塞问题')).toBeTruthy()
    expect(view.container.querySelector('[data-review-status="completed"]')).toBeTruthy()
  })

  it('keeps an admitted run visibly active while no Codex item has arrived', () => {
    const node = {
      key: 'reviewer:cmd-1', kind: 'reviewer', id: 'cmd-1', target: 'chat', anchorSeq: 1,
      location: { kind: 'unresolved' }, visibility: 'visible',
      data: data(assemble([at(1, 'review/start', { commandId: 'cmd-1', focus: '' })]))!,
    }
    const props = { node, t: makeTranslate(zh) } as unknown as Parameters<typeof ReviewerPanel>[0]
    render(<ReviewerPanel {...props} />)
    expect(screen.getByText('审查中')).toBeTruthy()
    expect(screen.getByText('等待 Codex 事件…')).toBeTruthy()
  })

  it.each([
    ['running', 'ongoing', zh.running],
    ['failed', 'error', zh.failed],
    ['cancelled', 'warning', zh.cancelled],
  ] as const)('renders the %s status and an empty activity list', (status, dot, label) => {
    const view = render(<ReviewerPanel {...panelProps({ focus: '', status, activities: [] })} />)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(view.container.querySelector(`[data-state="${dot}"]`)).toBeTruthy()
  })

  it('falls back from a missing activity detail to its public kind', () => {
    render(<ReviewerPanel {...panelProps({
      focus: '', status: 'running',
      activities: [{ activityId: 'tool', kind: 'tool', status: 'completed' }],
    })} />)
    expect(screen.getByText('tool')).toBeTruthy()
    expect(screen.getByText(zh.done)).toBeTruthy()
  })

  it('labels a started activity as still in progress', () => {
    render(<ReviewerPanel {...panelProps({
      focus: '', status: 'running',
      activities: [{ activityId: 'analysis', kind: 'analysis', status: 'started' }],
    })} />)
    expect(screen.getByText(zh.started)).toBeTruthy()
  })
})

describe('reviewer plugin lifecycle', () => {
  it('registers the Definition, locale, and keyed renderer', () => {
    const registerDefinition = vi.fn(() => () => {})
    const registerLocale = vi.fn(() => () => {})
    const registerSlot = vi.fn(() => () => {})
    const injectSlot = vi.fn((_name: string, install: () => unknown) => install())
    const effect = vi.fn((install: () => unknown) => install())
    applyClient({
      conversationEvents: { register: registerDefinition },
      locale: { register: registerLocale },
      slots: { inject: injectSlot, register: registerSlot },
      effect,
    } as never)
    expect(clientInject).toEqual(['conversationEvents', 'slots', 'locale'])
    expect(registerDefinition).toHaveBeenCalledWith(reviewerDefinition)
    expect(registerLocale).toHaveBeenCalledWith('reviewer', { zh, en })
    expect(registerSlot).toHaveBeenCalledWith({
      name: 'conversation.chat.node', key: 'reviewer', locale: 'reviewer',
    }, ReviewerPanel)
  })

  it('keeps the host-neutral entry inert and registers invariant ownership', async () => {
    expect(nodeName).toBe('client-ui-reviewer')
    expect(nodeInject).toEqual([])
    applyNode()
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, install: (ctx: Context) => void) => {
      install(new Context())
      return dispose
    })
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-reviewer', expect.any(Function))
  })
})
