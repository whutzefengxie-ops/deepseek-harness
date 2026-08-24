import type {
  ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-shadow-mind-runtime'

/** Shadow relay facts attached to the Step that admitted the report. */
export interface ShadowMindReportStepData {
  /** Durable root message sequence. */
  readonly reportSeq: number
  /** Number of accepted reports in the relay batch. */
  readonly reportCount: number
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationStepDataMap {
    /** Shadow relay admitted before the Step's root Assistant response. */
    'shadow-mind-report': ShadowMindReportStepData
  }
}

/** Target-free report projection; the generic context node remains the only Chat row. */
export const shadowReportStepDefinition: ConversationNodeDefinition<ShadowMindReportStepData> = {
  kind: 'shadow-mind-report',
  match: event => event.type === 'user/message'
    && isAppendSurfaceEvent(event)
    && event.data.source.kind === 'shadow-report'
    ? { id: String(event.data.id), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'user/message' || match.event.data.source.kind !== 'shadow-report') {
      throw new Error('shadow-mind-report start requires a shadow-report user/message')
    }
    return {
      reportSeq: match.event.seq,
      reportCount: match.event.data.source.reports.length,
    }
  },
  update: context => context.state,
  buildLocationData: (context, scope) => {
    const location = context.start?.location
    if (scope !== 'step' || context.state === undefined || location?.kind !== 'step') return null
    return {
      kind: 'step',
      turn: location.turn.turn,
      step: location.step.step,
      key: 'shadow-mind-report',
      value: context.state,
    }
  },
}

/** Combine every Shadow relay admitted in one closing Turn. */
function turnReports(turn: TurnLocation): ShadowMindReportStepData | null {
  let reportSeq = -1
  let reportCount = 0
  for (const step of turn.steps) {
    const report = step.data.get('shadow-mind-report')
    if (report === undefined) continue
    reportSeq = Math.max(reportSeq, report.reportSeq)
    reportCount += report.reportCount
  }
  return reportSeq === -1 ? null : { reportSeq, reportCount }
}

/**
 * Claim the closing reply marker only for a Turn that admitted a Shadow relay.
 * @param owner - Completed Turn and closing Assistant anchor.
 * @returns Combined relay facts, or null when the Turn consumed no Shadow report.
 */
export function selectShadowTriggered(owner: TurnTailOwnerProps): ShadowMindReportStepData | null {
  return turnReports(owner.turn)
}
