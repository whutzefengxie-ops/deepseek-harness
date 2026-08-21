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

/** Namespaced identity of one external Codex item. */
export type ReviewActivityId = `item:${string}`

/** Terminal state of one review run. */
export type ReviewOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Exact model request and execution facts admitted for one review. */
export interface ReviewRequestData {
  /** Complete prompt written to Codex stdin. */
  readonly prompt: string
  /** Canonical executable and arguments passed to the subprocess provider. */
  readonly argv: readonly string[]
  /** Explicit child environment entries required by the admitted executable form. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory in the subprocess provider's execution world. */
  readonly cwd: string
  /** Provider guarantee that loss of the Host terminates the admitted process tree. */
  readonly hostDeath: 'terminate'
  /** Maximum elapsed run time before the process tree is terminated. */
  readonly timeoutMs: number
}

/** Opens one durable review record after the Codex executable is admitted. */
export interface ReviewStartData {
  readonly commandId: CommandId
  readonly focus: string
  readonly request: ReviewRequestData
}

/** Records one real Codex JSONL progress transition. */
export interface ReviewActivityData {
  readonly commandId: CommandId
  readonly activityId: ReviewActivityId
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
     * @param data - command identity, human-supplied focus, and exact admitted request.
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
