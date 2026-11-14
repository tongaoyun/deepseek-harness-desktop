// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceActionsMenu } from '../src/client/ResourceActionsMenu.tsx'
import { zh } from '../src/locales.ts'

const t = (key: keyof typeof zh) => zh[key]
afterEach(cleanup)

it.each(['pending', 'permission'] as const)('closes connector actions after %s changes and requires reopening', (reason) => {
  const resource = { canEdit: true, canSubmit: true, canDelete: true, version: '1.0.0' }
  const props = { resource, onEdit: vi.fn(), onSubmit: vi.fn(), onDelete: vi.fn(), t }
  const view = render(<ResourceActionsMenu {...props} />)
  const original = screen.getByRole('button', { name: zh.resourceActions })
  original.focus()
  fireEvent.click(original)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.rerender(<ResourceActionsMenu {...props} pending={reason === 'pending'} resource={{ ...resource, canEdit: reason !== 'permission' }} />)
  expect(screen.queryByRole('menu')).toBeNull()
  if (reason === 'pending') {
    expect(screen.getByRole('button', { name: zh.resourceActions })).toBe(original)
    expect(original.hasAttribute('disabled')).toBe(false)
    expect(original.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(original)
    fireEvent.click(original)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(props.onEdit).not.toHaveBeenCalled()
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onDelete).not.toHaveBeenCalled()
  } else expect(screen.queryByRole('button', { name: zh.resourceActions })).toBeNull()
  view.rerender(<ResourceActionsMenu {...props} />)
  expect(screen.queryByRole('menu')).toBeNull()
  const trigger = screen.getByRole('button', { name: zh.resourceActions })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.submitShared }))
  expect(props.onSubmit).toHaveBeenCalledOnce()
  expect(props.onEdit).not.toHaveBeenCalled()
  expect(props.onDelete).not.toHaveBeenCalled()
})

it('keeps a shared connector delete action unavailable while allowing editing', () => {
  const props = { resource: { canEdit: true, canDelete: false, version: '1.0.0' }, onEdit: vi.fn(), onSubmit: vi.fn(), onDelete: vi.fn(), t }
  render(<ResourceActionsMenu {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.deleteResource }))
  expect(props.onDelete).not.toHaveBeenCalled()
  expect(screen.getByText(zh.resourceDeleteShared)).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: zh.modifyResource }))
  expect(props.onEdit).toHaveBeenCalledOnce()
})
