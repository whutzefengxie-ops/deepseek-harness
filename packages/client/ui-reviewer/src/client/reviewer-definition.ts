import type {
  ChatConversationViewNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ReviewActivityData, ReviewEndData, ReviewStartData } from '@deepseek-ai/dsh-command-reviewer/types'

/** One durable public Codex activity projected into the review card. */
export interface ReviewerActivity {
  readonly activityId: ReviewActivityData['activityId']
  readonly kind: ReviewActivityData['kind']
  readonly status: ReviewActivityData['status']
  readonly detail?: string
}
/** Durable review lifecycle state consumed by the keyed Chat renderer. */
export interface ReviewerChatData {
  readonly focus: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly activities: readonly ReviewerActivity[]
  readonly text?: string
}
/** Private replay accumulator whose activity index is snapshotted when a view node is published. */
interface ReviewerState {
  readonly commandId: CommandId
  readonly focus: string
  readonly status: ReviewerChatData['status']
  readonly activityById: Map<ReviewActivityData['activityId'], ReviewerActivity>
  readonly text?: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap { reviewer: ReviewerChatData }
}

function statusFromEnd(end: ReviewEndData['outcome']): ReviewerChatData['status'] {
  switch (end) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    /* v8 ignore next -- ReviewOutcome is closed and every variant is handled above. */
    default: return end satisfies never
  }
}

function updateState(state: ReviewerState, match: ConversationMatch): ReviewerState {
  if (match.event.type === 'review/activity') {
    const data = match.event.data
    const activity = {
      activityId: data.activityId,
      kind: data.kind,
      status: data.status,
      ...data.detail === undefined ? {} : { detail: data.detail },
    }
    state.activityById.set(data.activityId, activity)
    return state
  }
  if (match.event.type !== 'review/end') return state
  const data = match.event.data
  return { ...state, status: statusFromEnd(data.outcome), text: data.text }
}

function fallbackState(context: ConversationNodeContext<ReviewerState>): ReviewerState | undefined {
  if (context.matches.length === 0) return undefined
  let state: ReviewerState = {
    commandId: context.id as CommandId,
    focus: '',
    status: 'running',
    activityById: new Map(),
  }
  for (const match of context.matches) {
    if (match.event.type === 'review/start') {
      state = { ...state, commandId: match.event.data.commandId, focus: match.event.data.focus }
    } else {
      state = updateState(state, match)
    }
  }
  return state
}

/** Fold durable review lifecycle events into one stable Chat node. */
export const reviewerDefinition: ConversationNodeDefinition<ReviewerState> = {
  kind: 'reviewer',
  target: 'chat',
  match: (event) => {
    if (event.type === 'review/start') return { id: String(event.data.commandId), role: 'start' }
    if (event.type === 'review/activity' || event.type === 'review/end') return { id: String(event.data.commandId), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'review/start') throw new Error('reviewer start requires review/start')
    const data: ReviewStartData = match.event.data
    return { commandId: data.commandId, focus: data.focus, status: 'running', activityById: new Map() }
  },
  update: (context, match) => updateState(context.state, match),
  buildViewNode: (context) => {
    const anchor = context.start ?? context.matches[0]
    const state = context.state ?? fallbackState(context)
    if (anchor === undefined || state === undefined) return null
    const data: ReviewerChatData = {
      focus: state.focus,
      status: state.status,
      activities: [...state.activityById.values()],
      ...state.text === undefined ? {} : { text: state.text },
    }
    const node: ChatConversationViewNode = {
      key: context.key, kind: 'reviewer', id: context.id, target: 'chat',
      anchorSeq: anchor.event.seq, location: anchor.location,
      visibility: 'visible', presentationCommandId: state.commandId, data,
    }
    return node
  },
}
