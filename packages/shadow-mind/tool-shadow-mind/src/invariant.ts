/** Tool package companion with no independent runtime relationship. @module @deepseek-ai/dsh-tool-shadow-mind/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'tool-shadow-mind-invariant'
/** Invariant service dependency. */
export const inject = ['invariants']

// No runtime invariant: the runtime service owns the durable relay relation; this package only registers controls.
const install: InvariantInstaller = Object.assign(() => {}, { inject: [] })

/** Register the package's explained empty companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-tool-shadow-mind', install))
