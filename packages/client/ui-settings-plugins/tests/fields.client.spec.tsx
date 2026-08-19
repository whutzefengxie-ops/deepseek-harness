// @vitest-environment jsdom
/**
 * Field-control behavior: what a control renders for a staged draft, how an
 * overridden field offers its reset, and that a control never writes on its own.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecretField, SelectField, TextAreaField, ToggleField, ValueField } from '../src/client/fields.tsx'

afterEach(cleanup)

const frame = {
  id: 'field',
  label: 'Command timeout',
  hint: 'How long one command may run.',
  overriddenLabel: 'Overridden',
  resetLabel: 'Reset to default',
  invalidLabel: 'Enter a number.',
  disabled: false,
  overridden: false,
  invalid: false,
}

describe('ValueField', () => {
  it('stages every keystroke without writing', () => {
    const onEdit = vi.fn()
    render(<ValueField {...frame} text="60000" onEdit={onEdit} onReset={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Command timeout'), { target: { value: '9000' } })

    expect(onEdit).toHaveBeenCalledWith('9000')
  })

  it('renders the staged text it is given rather than a draft of its own', () => {
    const { rerender } = render(<ValueField {...frame} text="60000" onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByLabelText('Command timeout')).toHaveProperty('value', '60000')

    rerender(<ValueField {...frame} text="9000" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('value', '9000')
  })

  it('offers the reset only while an override would stand', () => {
    const onReset = vi.fn()
    const { rerender } = render(<ValueField {...frame} text="9000" onEdit={vi.fn()} onReset={onReset} />)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()

    rerender(<ValueField {...frame} overridden text="9000" onEdit={vi.fn()} onReset={onReset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    expect(screen.getByText('Overridden')).toBeTruthy()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('replaces the hint with the reason an invalid draft cannot be saved', () => {
    render(<ValueField {...frame} invalid text="soon" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByText('Enter a number.')).toBeTruthy()
    expect(screen.queryByText('How long one command may run.')).toBeNull()
    expect(screen.getByLabelText('Command timeout').getAttribute('aria-invalid')).toBe('true')
  })

  it('hints a numeric keypad and renders a placeholder when asked', () => {
    render(
      <ValueField
        {...frame}
        numeric
        placeholder="https://api.deepseek.com"
        text=""
        onEdit={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('Command timeout')

    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input).toHaveProperty('placeholder', 'https://api.deepseek.com')
  })

  it('disables the control and its reset while the document is read-only', () => {
    render(<ValueField {...frame} disabled overridden text="9000" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Reset to default' })).toHaveProperty('disabled', true)
  })
})

describe('SecretField', () => {
  const secret = {
    id: 'key',
    label: 'API key',
    hint: 'Stored outside the settings file.',
    disabled: false,
  }

  it('stages the draft and never renders it', () => {
    const onEdit = vi.fn()
    render(
      <SecretField
        {...secret}
        text=""
        configured={false}
        stateLabel="No key is configured."
        onEdit={onEdit}
      />,
    )
    const input = screen.getByLabelText('API key')

    fireEvent.change(input, { target: { value: 'ds-secret' } })

    expect(onEdit).toHaveBeenCalledWith('ds-secret')
    expect(input).toHaveProperty('type', 'password')
  })

  it('reports the configured state the Host holds', () => {
    const { rerender } = render(
      <SecretField
        {...secret}
        text=""
        configured={false}
        stateLabel="No key is configured."
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText('No key is configured.')).toBeTruthy()

    rerender(
      <SecretField
        {...secret}
        text="ds-secret"
        configured
        stateLabel="A key is configured."
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByText('A key is configured.')).toBeTruthy()
    expect(screen.getByLabelText('API key')).toHaveProperty('value', 'ds-secret')
  })

  it('disables the control when it is told to', () => {
    render(
      <SecretField
        {...secret}
        disabled
        text=""
        configured
        stateLabel="A key is configured."
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('API key')).toHaveProperty('disabled', true)
  })
})

describe('SelectField', () => {
  const select = {
    ...frame,
    options: ['low', 'medium', 'high'],
    optionLabels: ['Low', 'Medium', 'High'],
    placeholder: 'Use the default',
  }

  it('offers each option with its label and stages the selection', () => {
    const onEdit = vi.fn()
    render(<SelectField {...select} text="medium" onEdit={onEdit} onReset={vi.fn()} />)
    const control = screen.getByLabelText('Command timeout')

    expect(control).toHaveProperty('value', 'medium')
    expect(screen.getByRole('option', { name: 'Low' })).toHaveProperty('value', 'low')
    expect(screen.getByRole('option', { name: 'High' })).toHaveProperty('value', 'high')

    fireEvent.change(control, { target: { value: 'high' } })

    expect(onEdit).toHaveBeenCalledWith('high')
  })

  it('shows the placeholder while the draft is empty', () => {
    render(<SelectField {...select} text="" onEdit={vi.fn()} onReset={vi.fn()} />)

    const control = screen.getByLabelText('Command timeout') as HTMLSelectElement
    expect(control.value).toBe('')
    const placeholder = control.querySelector('option') as HTMLOptionElement
    expect(placeholder).not.toBeNull()
    expect(placeholder.disabled).toBe(true)
  })

  it('offers the reset only while an override would stand', () => {
    const onReset = vi.fn()
    const { rerender } = render(<SelectField {...select} text="high" onEdit={vi.fn()} onReset={onReset} />)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()

    rerender(<SelectField {...select} overridden text="high" onEdit={vi.fn()} onReset={onReset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    expect(screen.getByText('Overridden')).toBeTruthy()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('disables the control and its reset while the document is read-only', () => {
    render(<SelectField {...select} disabled overridden text="high" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Reset to default' })).toHaveProperty('disabled', true)
  })

  it('replaces the hint with the reason an invalid draft cannot be saved', () => {
    render(<SelectField {...select} invalid text="stale" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByText('Enter a number.')).toBeTruthy()
    expect(screen.queryByText('How long one command may run.')).toBeNull()
    expect(screen.getByLabelText('Command timeout').getAttribute('aria-invalid')).toBe('true')
  })

  it('falls back to the option value when no label is supplied for it', () => {
    render(<SelectField {...select} optionLabels={['Low']} text="medium" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByRole('option', { name: 'medium' })).toHaveProperty('value', 'medium')
  })
})

describe('TextAreaField', () => {
  it('renders the staged text and stages every edit', () => {
    const onEdit = vi.fn()
    render(<TextAreaField {...frame} rows={5} text="line one" onEdit={onEdit} onReset={vi.fn()} />)
    const control = screen.getByLabelText('Command timeout')

    expect(control).toHaveProperty('value', 'line one')
    expect(control).toHaveProperty('rows', 5)

    fireEvent.change(control, { target: { value: 'line two' } })

    expect(onEdit).toHaveBeenCalledWith('line two')
  })

  it('offers the reset for an overridden field and disables when read-only', () => {
    const onReset = vi.fn()
    const { rerender } = render(<TextAreaField {...frame} overridden text="kept" onEdit={vi.fn()} onReset={onReset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(onReset).toHaveBeenCalledOnce()

    rerender(<TextAreaField {...frame} disabled overridden text="kept" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('disabled', true)
  })

  it('defaults to four rows and reports an invalid draft', () => {
    const { rerender } = render(<TextAreaField {...frame} text="kept" onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByLabelText('Command timeout')).toHaveProperty('rows', 4)

    rerender(<TextAreaField {...frame} invalid text="kept" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByText('Enter a number.')).toBeTruthy()
    expect(screen.getByLabelText('Command timeout').getAttribute('aria-invalid')).toBe('true')
  })
})

describe('ToggleField', () => {
  const toggle = {
    ...frame,
    toggleOnLabel: 'Enabled',
    toggleOffLabel: 'Disabled',
  }

  it('reflects the staged draft as a checked box and stages the flip', () => {
    const onEdit = vi.fn()
    const { rerender } = render(<ToggleField {...toggle} text="true" onEdit={onEdit} onReset={vi.fn()} />)
    const control = screen.getByLabelText('Command timeout')

    expect(control).toHaveProperty('checked', true)
    expect(screen.getByText('Enabled')).toBeTruthy()

    fireEvent.click(control)
    expect(onEdit).toHaveBeenCalledWith('false')

    rerender(<ToggleField {...toggle} text="false" onEdit={onEdit} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('checked', false)
    expect(screen.getByText('Disabled')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Command timeout'))
    expect(onEdit).toHaveBeenCalledWith('true')
  })

  it('reads an inherited empty draft as unchecked', () => {
    render(<ToggleField {...toggle} text="" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('checked', false)
    expect(screen.getByText('Disabled')).toBeTruthy()
  })

  it('offers the reset only while an override would stand', () => {
    const onReset = vi.fn()
    const { rerender } = render(<ToggleField {...toggle} text="true" onEdit={vi.fn()} onReset={onReset} />)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()

    rerender(<ToggleField {...toggle} overridden text="true" onEdit={vi.fn()} onReset={onReset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    expect(screen.getByText('Overridden')).toBeTruthy()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('disables the control and its reset while the document is read-only', () => {
    render(<ToggleField {...toggle} disabled overridden text="true" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Reset to default' })).toHaveProperty('disabled', true)
  })

  it('replaces the hint with the reason an invalid draft cannot be saved', () => {
    render(<ToggleField {...toggle} invalid text="yes" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByText('Enter a number.')).toBeTruthy()
    expect(screen.queryByText('How long one command may run.')).toBeNull()
    expect(screen.getByLabelText('Command timeout')).toHaveProperty('checked', false)
  })
})
