/** Expose the product headless maintenance marker to the direct snapshot driver. */

import type { Context } from '@deepseek-ai/cordis'

/** Loader plugin name. */
export const name = 'shadow-mind-headless-marker'

/** Publish the marker; the direct snapshot driver owns the actual task. */
export function apply(ctx: Context): void {
  ctx.provide('headlessStartup', { task: 'owned by the snapshot driver' })
}
