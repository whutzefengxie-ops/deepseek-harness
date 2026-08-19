/** The reviewer plugin's card: the Codex review command's enable switch, model, and review instructions. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SelectField, TextAreaField, ToggleField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { ReviewerCardFace } from './reviewer-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the reviewer card. */
export type ReviewerCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<ReviewerCardFace>

/**
 * Render the reviewer card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function ReviewerCard(props: ReviewerCardProps) {
  const { t } = props
  const state = props.useReviewerCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="reviewerTitle"
      descriptionKey="reviewerDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ToggleField
        id="plugin-config-reviewer-enabled"
        label={t('reviewerEnabled')}
        hint={t('reviewerEnabledHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        toggleOnLabel={t('reviewerEnabledOn')}
        toggleOffLabel={t('reviewerEnabledOff')}
        disabled={disabled}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="plugin-config-reviewer-model"
        label={t('reviewerModel')}
        hint={t('reviewerModelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        placeholder={t('reviewerModelPlaceholder')}
        disabled={disabled}
        {...state.model}
        onEdit={(text) => { props.edit('model', text) }}
        onReset={() => { props.resetField('model') }}
      />
      <SelectField
        id="plugin-config-reviewer-thinking"
        label={t('reviewerThinkingEffort')}
        hint={t('reviewerThinkingEffortHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        placeholder={t('reviewerSelectPlaceholder')}
        options={['low', 'medium', 'high']}
        optionLabels={[t('reviewerEffortLow'), t('reviewerEffortMedium'), t('reviewerEffortHigh')]}
        disabled={disabled}
        {...state.thinkingEffort}
        onEdit={(text) => { props.edit('thinkingEffort', text) }}
        onReset={() => { props.resetField('thinkingEffort') }}
      />
      <SelectField
        id="plugin-config-reviewer-sandbox"
        label={t('reviewerSandbox')}
        hint={t('reviewerSandboxHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        placeholder={t('reviewerSelectPlaceholder')}
        options={['read-only', 'workspace-write', 'danger-full-access']}
        optionLabels={[t('reviewerSandboxReadOnly'), t('reviewerSandboxWorkspaceWrite'), t('reviewerSandboxFullAccess')]}
        disabled={disabled}
        {...state.sandbox}
        onEdit={(text) => { props.edit('sandbox', text) }}
        onReset={() => { props.resetField('sandbox') }}
      />
      <TextAreaField
        id="plugin-config-reviewer-prompt"
        label={t('reviewerPrompt')}
        hint={t('reviewerPromptHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        rows={5}
        disabled={disabled}
        {...state.prompt}
        onEdit={(text) => { props.edit('prompt', text) }}
        onReset={() => { props.resetField('prompt') }}
      />
      <TextAreaField
        id="plugin-config-reviewer-context"
        label={t('reviewerContext')}
        hint={t('reviewerContextHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        rows={3}
        disabled={disabled}
        {...state.context}
        onEdit={(text) => { props.edit('context', text) }}
        onReset={() => { props.resetField('context') }}
      />
    </PluginCard>
  )
}
