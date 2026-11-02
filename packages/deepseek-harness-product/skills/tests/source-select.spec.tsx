// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSourceSelect } from '../src/source-select.ts'

const SourceSelect = createSourceSelect(React)
afterEach(cleanup)

it.each([
  { name: 'source filter', action: false, icon: undefined },
  { name: 'text action', action: true, icon: undefined },
  { name: 'icon action', action: true, icon: <span aria-hidden="true">…</span> },
])('closes a disabled $name and requires a new action after enabling', (variant) => {
  const onChange = vi.fn()
  const props = { label: 'Source', value: 'local', options: [{ value: 'local', label: 'Local' }],
    action: variant.action, icon: variant.icon, onChange }
  const view = render(<SourceSelect {...props} />)
  const trigger = screen.getByRole('button', { name: 'Source' })
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  fireEvent.click(trigger)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.rerender(<SourceSelect {...props} disabled />)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger).toHaveProperty('disabled', true)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(trigger)
  expect(onChange).not.toHaveBeenCalled()
  view.rerender(<SourceSelect {...props} />)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Local' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('local')
})

it.each([{ name: 'IME', init: { isComposing: true } }, { name: 'modified shortcut', init: { ctrlKey: true } }])(
  'keeps the source menu open when Escape belongs to $name', ({ init }) => {
    render(<SourceSelect label="Source" value="local" options={[{ value: 'local', label: 'Local' }]} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Source' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape', ...init })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  },
)

it('keeps a background source menu while a foreground native dialog owns Escape', () => {
  render(<SourceSelect label="Source" value="local" options={[{ value: 'local', label: 'Local' }]} onChange={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: 'Source' })
  trigger.focus()
  fireEvent.click(trigger)
  const close = vi.fn()
  const foreground = render(<Modal open title="Foreground" closeLabel="Close foreground" onClose={close} />)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('menu')).toBeTruthy()
  foreground.unmount()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
})
