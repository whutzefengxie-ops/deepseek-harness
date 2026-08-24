import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShadowMindReportStepData } from './shadow-report-conversation.ts'
import type { NS } from './index.ts'
import css from './ShadowTriggeredTail.module.css'

/** Selector-matched Shadow report trigger marker props. */
export type ShadowTriggeredTailProps = {
  matched: ShadowMindReportStepData
} & PropsLocale<typeof NS>

/** Mark a completed root response as caused by durable Shadow report input. */
export function ShadowTriggeredTail({ matched, t }: ShadowTriggeredTailProps) {
  const countKey = matched.reportCount === 1 ? 'reportCountOne' : 'reportCountOther'
  return (
    <div className={css.root} data-shadow-triggered>
      <span className={css.dot} aria-hidden />
      <span>{t('triggeredReply')}</span>
      <span className={css.count}>{t(countKey, { count: matched.reportCount })}</span>
    </div>
  )
}
