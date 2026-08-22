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
  }
}

/** Install durable relay provenance checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('session/event', (_session, event) => { validate(event, fail) }, { global: true })
}, { inject: [] })

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
