// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSourceSelect } from '../src/source-select.ts'

const SourceSelect = createSourceSelect(React)
afterEach(cleanup)

it.each([{ name: 'IME', init: { isComposing: true } }, { name: 'modified shortcut', init: { ctrlKey: true } }])(
  'keeps the source menu open when Escape belongs to $name', ({ init }) => {
    render(<SourceSelect label="Source" value="local" options={[{ value: 'local', label: 'Local' }]} onChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
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
  const trigger = screen.getByRole('combobox')
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
