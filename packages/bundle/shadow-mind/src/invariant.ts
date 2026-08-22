/** Static Shadow Mind bundle invariant companion. @module @deepseek-ai/dsh-shadow-mind/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'shadow-mind-bundle-invariant'
/** Invariant service dependency. */
export const inject = ['invariants']

// No runtime invariant: the bundle owns only a static patch; inserted packages own runtime relations.
const install: InvariantInstaller = () => {}

/**
 * Register the bundle's explained empty companion.
 * @param ctx Cordis context carrying the invariant service.
 * @returns Installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-shadow-mind', install))
