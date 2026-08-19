import { MarkdownText, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewerChatData } from './reviewer-definition.ts'
import css from './ReviewerPanel.module.css'

type Props = PropsRuntime<'conversation.chat.node', 'reviewer'> & PropsLocale<'reviewer'>

function statusText(status: ReviewerChatData['status'], t: Props['t']): string {
  if (status === 'running') return t('running')
  if (status === 'completed') return t('completed')
  if (status === 'failed') return t('failed')
  return t('cancelled')
}
function dotState(status: ReviewerChatData['status']): StateDotState {
  if (status === 'running') return 'ongoing'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  return 'warning'
}

/** Render one replayable review lifecycle and its final Markdown. */
export function ReviewerPanel({ node, t }: Props) {
  const data = node.data
  return <section className={css.root} data-reviewer data-review-status={data.status}>
    <div className={css.header}>
      <StateDot state={dotState(data.status)} />
      <span>{t('title')}</span>
      <span className={css.status}>{statusText(data.status, t)}</span>
    </div>
    {data.focus.length > 0 && <div className={css.focus}>{data.focus}</div>}
    <div className={css.activities} aria-label={t('activity')}>
      {data.activities.length === 0
        ? <span className={css.empty}>{t('empty')}</span>
        : data.activities.map(activity => <div className={css.activity} key={activity.activityId}>
          <span>{activity.detail ?? activity.kind}</span>
          <span className={css.activityStatus}>{activity.status === 'started' ? t('started') : t('done')}</span>
        </div>)}
    </div>
    {data.text !== undefined && <div className={css.text}><MarkdownText text={data.text} /></div>}
  </section>
}
