// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSourceSelect } from '../src/source-select.ts'

const SourceSelect = createSourceSelect(React)
afterEach(cleanup)

it.each([false, true])('restores the skill action trigger after closing its dialog, with icon=%s', async (icon) => {
  function Actions() {
    const [open, setOpen] = React.useState(false)
    return <><SourceSelect action label="Skill actions" icon={icon ? <span aria-hidden="true">…</span> : undefined}
      options={[{ value: 'category', label: 'Change category' }]} onChange={() => { setOpen(true) }} />
    <Modal open={open} title="Category" closeLabel="Close category" onClose={() => { setOpen(false) }}>
      <input aria-label="Category name" />
    </Modal></>
  }
  render(<Actions />)
  const trigger = screen.getByRole('button', { name: 'Skill actions' })
  trigger.focus()
  fireEvent.click(trigger)
  const item = screen.getByRole('menuitem', { name: 'Change category' })
  item.focus()
  fireEvent.click(item)
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => { expect(dialog.contains(document.activeElement)).toBe(true) })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(document.activeElement).toBe(trigger)
})

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

it.each([false, true])('retains a pending source control and closes its menu without enabling actions, action=%s', (action) => {
  const onChange = vi.fn()
  const props = { action, label: 'Source', value: 'local', options: [{ value: 'local', label: 'Local' }], onChange }
  const view = render(<SourceSelect {...props} />)
  const trigger = screen.getByRole<HTMLButtonElement>('button', { name: 'Source' })
  trigger.focus()
  fireEvent.click(trigger)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.rerender(<SourceSelect {...props} pending />)
  expect(screen.getByRole('button', { name: 'Source' })).toBe(trigger)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger.disabled).toBe(false)
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-busy')).toBe('true')
  expect(trigger.classList.contains('product-control-pending')).toBe(true)
  fireEvent.click(trigger)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
  view.rerender(<SourceSelect {...props} />)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger.disabled).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-busy')).not.toBe('true')
  view.rerender(<SourceSelect {...props} disabled pending />)
  expect(trigger.disabled).toBe(true)
  expect(trigger.classList.contains('product-control-pending')).toBe(false)
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
