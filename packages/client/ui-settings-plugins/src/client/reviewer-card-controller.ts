/** The reviewer card's staged form over the `command-reviewer` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  boolField, CardForm, selectField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the reviewer command. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the owning plugin
 * spells the same value.
 */
export const REVIEWER_NS = 'command-reviewer'

/** Browser-side preview of the Host schema's portable Codex model identifier. */
const REVIEWER_MODEL_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._:/@+-]*)?$/

/** The reviewer fields this card edits — a subset of the served schema by design. */
export interface ReviewerSettings {
  enabled?: boolean
  model?: string
  thinkingEffort?: string
  sandbox?: string
  prompt?: string
  context?: string
}

/** What the reviewer card renders. */
export interface ReviewerCardState extends CardShell {
  enabled: CardFieldState
  model: CardFieldState
  thinkingEffort: CardFieldState
  sandbox: CardFieldState
  prompt: CardFieldState
  context: CardFieldState
}

/** The registration-side face the reviewer card's slot entry injects. */
export interface ReviewerCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useReviewerCard. */
    reviewerCard: SnapshotStore<ReviewerCardState>
  }
}

/** Bridges the `command-reviewer` scope onto the reviewer card's staged form. */
export class ReviewerCardController {
  private readonly form: CardForm<ReviewerSettings>
  private readonly store: SnapshotStore<ReviewerCardState>

  /** @param scope - the bound settings scope for the `command-reviewer` namespace. */
  constructor(scope: SettingsScope<ReviewerSettings>) {
    this.form = new CardForm(scope, [
      boolField('enabled'),
      textField('model', REVIEWER_MODEL_PATTERN, 'set'),
      selectField('thinkingEffort', ['low', 'medium', 'high']),
      selectField('sandbox', ['read-only', 'workspace-write', 'danger-full-access']),
      textField('prompt', undefined, 'set'),
      textField('context', undefined, 'set'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ReviewerCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      model: this.form.field('model'),
      thinkingEffort: this.form.field('thinkingEffort'),
      sandbox: this.form.field('sandbox'),
      prompt: this.form.field('prompt'),
      context: this.form.field('context'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): ReviewerCardFace {
    return { hooks: { reviewerCard: this.store }, ...this.form.actions() }
  }
}
