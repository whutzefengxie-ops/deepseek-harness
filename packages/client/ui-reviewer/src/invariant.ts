/** Package-owned invariant companion for the browser reviewer surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'client-ui-reviewer-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: the Conversation and Chat contributions use registries
 * whose owners validate registration identity and lifecycle.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-ui-reviewer', install))
