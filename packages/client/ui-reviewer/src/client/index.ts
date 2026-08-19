import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locales.ts'
import { ReviewerPanel } from './ReviewerPanel.tsx'
import { reviewerDefinition } from './reviewer-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { reviewer: import('./locales.ts').ReviewerKey }
}

export const inject = ['conversationEvents', 'slots', 'locale']

/** Register the durable reviewer Definition, copy, and keyed chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(reviewerDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-reviewer: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'reviewer', locale: NS,
  }, ReviewerPanel))
}
