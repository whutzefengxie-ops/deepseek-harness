/** Package invariant registration for the Shadow Mind browser administration module. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'client-ui-shadow-mind-invariant'
/** Invariant service dependency. */
export const inject = ['invariants']

/** No runtime invariant: Host methods own persistence, while client registration disposal is covered by tests. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx Cordis context carrying the invariant service.
 * @returns Registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-ui-shadow-mind', install))
