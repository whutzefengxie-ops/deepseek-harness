/** Shadow report provenance invariants. @module @deepseek-ai/dsh-shadow-mind-runtime/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './protocol.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-shadow-mind-runtime'

/** Cordis companion plugin name. */
export const name = 'shadow-mind-runtime-invariant'
/** Invariant service dependency. */
export const inject = ['invariants']

/** Assert relationships owned by one durable Shadow relay. */
function validate(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'user/message' || event.data.source.kind !== 'shadow-report') return
  const reports = event.data.source.reports
  if (reports.length === 0) fail('shadow-report messages must cite at least one report')
  const runIds = new Set<string>()
  for (const report of reports) {
    if (report.shadowId.length === 0 || report.runId.length === 0 || String(report.childSessionId).length === 0) {
      fail('shadow-report provenance ids must be non-empty')
    }
    if (runIds.has(report.runId)) fail(`shadow-report repeats run id ${JSON.stringify(report.runId)}`)
    runIds.add(report.runId)
    if (!Number.isSafeInteger(report.capturedThroughSeq) || report.capturedThroughSeq < 0
      || report.capturedThroughSeq >= event.seq) {
      fail(`shadow-report capturedThroughSeq must precede message seq ${String(event.seq)}`)
    }
    if (report.verdict !== 'challenge' && report.verdict !== 'gap'
      && report.verdict !== 'confirm' && report.verdict !== 'uncertain') {
      fail('shadow-report provenance requires a known verdict')
    }
    if (report.severity !== undefined
      && (!Number.isFinite(report.severity) || report.severity < 0 || report.severity > 1)) {
      fail('shadow-report severity must be a finite number from zero through one')
    }
    let previous = -1
    for (const ref of report.refs ?? []) {
      if (!Number.isSafeInteger(ref) || ref <= 0 || ref <= previous || ref >= event.seq) {
        fail('shadow-report refs must be ascending unique positive sequence numbers before the relay')
      }
      previous = ref
    }
    if (report.replacesRunIds !== undefined) {
      if (report.replacesRunIds.length !== 2
        || report.replacesRunIds.some(id => id.length === 0 || id === report.runId)
        || new Set(report.replacesRunIds).size !== report.replacesRunIds.length) {
        fail('shadow-report synthesis provenance must replace two distinct original run ids')
      }
    }
  }
}

/** Install durable relay provenance checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('session/event', (_session, event) => { validate(event, fail) }, { global: true })
}, { inject: [] })

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
