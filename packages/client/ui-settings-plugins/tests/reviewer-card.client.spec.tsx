// @vitest-environment jsdom
/** The reviewer card: what it shows, and which form actions each control stages. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { ReviewerCard } from '../src/client/ReviewerCard.tsx'
import type { ReviewerCardProps } from '../src/client/ReviewerCard.tsx'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import type { ReviewerCardState } from '../src/client/reviewer-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** A settled form: nothing staged, everything served. */
const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

/** One control's state, defaulting to an inherited value. */
function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function renderReviewer(state: Partial<ReviewerCardState> = {}) {
  const store = createSnapshotStore<ReviewerCardState>({
    ...settled,
    enabled: field('true'),
    model: field(''),
    thinkingEffort: field('medium'),
    sandbox: field('read-only'),
    prompt: field(''),
    context: field(''),
    ...state,
  })
  const actions = {
    edit: vi.fn(),
    resetField: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = { ...actions, t, useReviewerCard: bindSnapshotSelector(store) } as unknown as ReviewerCardProps
  render(<ReviewerCard {...props} />)
  return actions
}

function expand(): void {
  fireEvent.click(screen.getByText(en.reviewerTitle))
}

describe('ReviewerCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderReviewer({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.reviewerTitle)).toBeNull()
  })

  it('shows the plugin and reveals its fields only once expanded', () => {
    renderReviewer()
    expect(screen.getByText(en.reviewerTitle)).toBeTruthy()
    expect(screen.queryByLabelText(en.reviewerModel)).toBeNull()

    expand()

    expect(screen.getByLabelText(en.reviewerEnabled)).toBeTruthy()
    expect(screen.getByLabelText(en.reviewerModel)).toBeTruthy()
    expect(screen.getByLabelText(en.reviewerThinkingEffort)).toBeTruthy()
    expect(screen.getByLabelText(en.reviewerSandbox)).toBeTruthy()
    expect(screen.getByLabelText(en.reviewerPrompt)).toBeTruthy()
    expect(screen.getByLabelText(en.reviewerContext)).toBeTruthy()
  })

  it('stages the enable toggle as the boolean draft vocabulary', () => {
    const actions = renderReviewer()
    expand()

    fireEvent.click(screen.getByLabelText(en.reviewerEnabled))

    expect(actions.edit).toHaveBeenCalledWith('enabled', 'false')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('stages the model and the text fields', () => {
    const actions = renderReviewer()
    expand()

    fireEvent.change(screen.getByLabelText(en.reviewerModel), { target: { value: 'gpt-5.1-codex-max' } })
    fireEvent.change(screen.getByLabelText(en.reviewerPrompt), { target: { value: 'Be strict.' } })
    fireEvent.change(screen.getByLabelText(en.reviewerContext), { target: { value: 'Security review.' } })

    expect(actions.edit.mock.calls).toEqual([
      ['model', 'gpt-5.1-codex-max'],
      ['prompt', 'Be strict.'],
      ['context', 'Security review.'],
    ])
  })

  it('stages the thinking-effort and sandbox selections', () => {
    const actions = renderReviewer()
    expand()

    fireEvent.change(screen.getByLabelText(en.reviewerThinkingEffort), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText(en.reviewerSandbox), { target: { value: 'workspace-write' } })

    expect(actions.edit.mock.calls).toEqual([
      ['thinkingEffort', 'high'],
      ['sandbox', 'workspace-write'],
    ])
  })

  it('shows field-specific validation copy', () => {
    renderReviewer({
      invalid: true,
      model: field('gpt 5', { invalid: true }),
      sandbox: field('root', { invalid: true }),
    })
    expand()

    expect(screen.getByText(en.reviewerModelInvalid)).toBeTruthy()
    expect(screen.getByText(en.invalidValue)).toBeTruthy()
    expect(screen.queryByText(en.invalidNumber)).toBeNull()
  })

  it('addresses each field with its own reset', () => {
    const actions = renderReviewer({
      enabled: field('false', { overridden: true }),
      model: field('gpt-5.1-codex-mini', { overridden: true }),
      thinkingEffort: field('high', { overridden: true }),
      sandbox: field('workspace-write', { overridden: true }),
      prompt: field('Be strict.', { overridden: true }),
      context: field('Security review.', { overridden: true }),
    })
    expand()

    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(6)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.resetField.mock.calls).toEqual([
      ['enabled'],
      ['model'],
      ['thinkingEffort'],
      ['sandbox'],
      ['prompt'],
      ['context'],
    ])
  })

  it('saves and discards through the shared card footer', () => {
    const actions = renderReviewer({ dirty: true, enabled: field('false', { overridden: true }) })
    expand()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('disables every control while the document is read-only', () => {
    renderReviewer({ writable: false })
    expand()

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.reviewerEnabled)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.reviewerModel)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.reviewerThinkingEffort)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.reviewerSandbox)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.reviewerPrompt)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.reviewerContext)).toHaveProperty('disabled', true)
  })
})
