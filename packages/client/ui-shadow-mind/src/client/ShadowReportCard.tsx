import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ContextRowProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContextMessageNode, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ShadowReportMessageSource, ShadowReportProvenance,
} from '@deepseek-ai/dsh-shadow-mind-runtime'
import type { NS } from './index.ts'
import css from './ShadowReportCard.module.css'

/** One durable Shadow report paired with its human-readable section. */
export interface ShadowReportCardEntry extends ShadowReportProvenance {
  /** Display name recorded in the report section heading. */
  readonly name: string
  /** Exact accepted report text from the model-facing message. */
  readonly content: string
}

/** Browser actions injected into the report card. */
export interface ShadowReportCardInjected {
  /** Open the published Shadow child Session. */
  openSession: (sessionId: SessionId) => void
}

/** Dedicated Shadow report row props. */
export type ShadowReportCardProps = ContextRowProps
  & PropsLocale<typeof NS>
  & InjectFace<ShadowReportCardInjected>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function shadowSource(source: unknown): ShadowReportMessageSource | null {
  if (typeof source !== 'object' || source === null) return null
  const candidate = source as Partial<ShadowReportMessageSource>
  return candidate.kind === 'shadow-report'
    && candidate.form === 'relay'
    && Array.isArray(candidate.reports)
    && candidate.reports.length > 0
    && candidate.reports.every((report: unknown) => {
      if (typeof report !== 'object' || report === null) return false
      const fields = report as Record<string, unknown>
      return typeof fields['shadowId'] === 'string'
        && fields['shadowId'] !== ''
        && typeof fields['runId'] === 'string'
        && fields['runId'] !== ''
        && typeof fields['childSessionId'] === 'string'
        && fields['childSessionId'] !== ''
        && typeof fields['capturedThroughSeq'] === 'number'
        && Number.isSafeInteger(fields['capturedThroughSeq'])
        && fields['capturedThroughSeq'] >= 0
    })
    ? candidate as ShadowReportMessageSource
    : null
}

function modelText(content: ContextMessageNode['content']): string | null {
  if (content.some(block => block.type !== 'text')) return null
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Pair the ordered provenance list with the runtime-owned Markdown report sections. */
export function parseShadowReportBatch(node: ContextMessageNode): readonly ShadowReportCardEntry[] | null {
  const source = shadowSource(node.source)
  const text = modelText(node.content)
  if (source === null || text === null) return null
  const markers: Array<{ name: string; bodyStart: number; markerStart: number }> = []
  let cursor = 0
  for (const report of source.reports) {
    const pattern = new RegExp(`\\n### ([^\\r\\n]+) \\(${escapeRegExp(report.shadowId)}\\)\\r?\\n`, 'gu')
    pattern.lastIndex = cursor
    const match = pattern.exec(text)
    if (match === null || match[1] === undefined) return null
    markers.push({ name: match[1].trim(), markerStart: match.index, bodyStart: pattern.lastIndex })
    cursor = pattern.lastIndex
  }
  const first = markers[0]
  if (first === undefined) return null
  const entries: ShadowReportCardEntry[] = []
  for (const [index, report] of source.reports.entries()) {
    const marker = markers[index]
    if (marker === undefined) return null
    const next = markers[index + 1]
    const content = text.slice(marker.bodyStart, next?.markerStart ?? text.length).trim()
    if (content === '' || marker.name === '') return null
    entries.push({ ...report, name: marker.name, content })
  }
  return entries
}

/** Render a batched relay as visible Shadow reports with durable provenance. */
export function ShadowReportCard({ node, fallback, openSession, t }: ShadowReportCardProps) {
  const reports = parseShadowReportBatch(node)
  if (reports === null) return fallback
  const countKey = reports.length === 1 ? 'reportCountOne' : 'reportCountOther'
  return (
    <section className={css.root} data-shadow-report-card>
      <header className={css.header}>
        <span className={css.mark} aria-hidden>S</span>
        <div>
          <strong>{t('reportCardTitle')}</strong>
          <span>{t(countKey, { count: reports.length })}</span>
        </div>
      </header>
      <div className={css.reports}>
        {reports.map(report => (
          <article className={css.report} key={report.runId}>
            <div className={css.reportHeader}>
              <strong>{report.name}</strong>
              <code>{report.shadowId}</code>
            </div>
            <pre className={css.content}>{report.content}</pre>
            <div className={css.meta}>
              <button
                type="button"
                title={report.childSessionId}
                aria-label={t('openChildSession', { id: report.childSessionId })}
                onClick={() => { openSession(report.childSessionId) }}
              >
                {t('childSession')}: <code>{report.childSessionId}</code>
              </button>
              <span>{t('reportCapturedSeq', { seq: report.capturedThroughSeq })}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
