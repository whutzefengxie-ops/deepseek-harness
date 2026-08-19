/**
 * Browser-safe durable lifecycle for one `/review` run.
 * @module @deepseek-ai/dsh-command-reviewer/types
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

/** User-visible category for one Codex progress item. */
export type ReviewActivityKind =
  | 'analysis'
  | 'command'
  | 'tool'
  | 'web-search'
  | 'file-change'
  | 'message'
  | 'other'

/** Lifecycle state of one progress item. */
export type ReviewActivityStatus = 'started' | 'completed'

/** Terminal state of one review run. */
export type ReviewOutcome = 'completed' | 'failed' | 'cancelled'

/** Opens one durable review record after the Codex executable is admitted. */
export interface ReviewStartData {
  readonly commandId: CommandId
  readonly focus: string
}

/** Records one real Codex JSONL progress transition. */
export interface ReviewActivityData {
  readonly commandId: CommandId
  readonly activityId: string
  readonly kind: ReviewActivityKind
  readonly status: ReviewActivityStatus
  readonly detail?: string
}

/** Settles one review after its process tree and output stream have closed. */
export interface ReviewEndData {
  readonly commandId: CommandId
  readonly outcome: ReviewOutcome
  readonly text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one log-only review record.
     * @param data - command identity and optional human-supplied focus.
     */
    'review/start': ReviewStartData
    /**
     * Records one log-only progress transition emitted by `codex exec --json`.
     * @param data - review identity, activity identity, category, state, and optional safe summary.
     */
    'review/activity': ReviewActivityData
    /**
     * Closes one log-only review record with its final rendered text.
     * @param data - review identity, terminal outcome, and result or diagnostic text.
     */
    'review/end': ReviewEndData
  }
}
