// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createDestinationPicker } from '../src/destination-picker.ts'
import type { DestinationPickerProps } from '../src/destination-types.ts'
import { createSourceSelect } from '../src/source-select.ts'

afterEach(cleanup)
const SourceSelect = createSourceSelect(React)
const DestinationPicker = createDestinationPicker({ react: React, SourceSelect, translateError: (_t, error) => String(error) })
function props(scope: 'user' | 'workspace'): DestinationPickerProps {
  return {
    t: key => key,
    value: { scope, location: 'dsh', workspace: scope === 'workspace' ? '/project' : '' },
    onChange: vi.fn(),
    workspaces: [{ name: 'Project', path: '/project', registeredPaths: ['/project'], available: true, skillCount: 0 }],
    userDestinations: [{ key: 'dsh', path: '/user/skills', label: 'DSH', available: true }],
    allowAgents: true,
  }
}

it.each([
  { scope: 'workspace' as const, lock: { loading: true }, label: 'dest.workspace', path: '/project/.dsh/skills' },
  { scope: 'workspace' as const, lock: { disabled: true }, label: 'dest.workspace', path: '/project/.dsh/skills' },
  { scope: 'user' as const, lock: { disabled: true }, label: 'dest.location', path: '/user/skills' },
])('retains the $scope destination during $lock', ({ scope, lock, label, path }) => {
  const initial = props(scope)
  const view = render(<DestinationPicker {...initial} />)
  const trigger = screen.getByRole<HTMLButtonElement>('button', { name: label })
  const glyph = trigger.querySelector('svg')
  const selected = trigger.textContent
  const preview = screen.getByText(path)
  fireEvent.click(trigger)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.rerender(<DestinationPicker {...initial} {...lock} />)
  expect(screen.getByRole('button', { name: label })).toBe(trigger)
  expect(trigger.textContent).toBe(selected)
  expect(trigger.querySelector('svg')).toBe(glyph)
  expect(screen.getByText(path)).toBe(preview)
  expect(trigger.disabled).toBe(true)
  expect(trigger.getAttribute('aria-busy')).toBe('true')
  expect(trigger.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('menu')).toBeNull()
  if (lock.disabled) {
    expect(screen.getByRole('button', { name: 'dest.scope' }).classList.contains('product-control-pending')).toBe(true)
  }
  fireEvent.click(trigger)
  expect(initial.onChange).not.toHaveBeenCalled()
  view.rerender(<DestinationPicker {...initial} />)
  expect(trigger.disabled).toBe(false)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: scope === 'workspace' ? 'Project' : 'dest.location.dsh' }))
  expect(initial.onChange).toHaveBeenCalledExactlyOnceWith(scope === 'workspace' ? { workspace: '/project' } : { location: 'dsh' })
})

it.each(['empty', 'error'] as const)('keeps an unavailable workspace disabled during a pending operation: %s', (reason) => {
  const initial = props('workspace')
  render(<DestinationPicker {...initial} disabled loading
    workspaces={reason === 'empty' ? [] : initial.workspaces}
    workspaceError={reason === 'error' ? 'Workspace unavailable' : undefined} />)
  const trigger = screen.getByRole<HTMLButtonElement>('button', { name: 'dest.workspace' })
  expect(trigger.disabled).toBe(true)
  expect(trigger.classList.contains('product-control-pending')).toBe(false)
  fireEvent.click(trigger)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(initial.onChange).not.toHaveBeenCalled()
})

it.each(['available', 'empty', 'unavailable'] as const)(
  'recovers removed workspace retry focus after an %s result without scrolling or stealing focus', (result) => {
    const initial = props('workspace')
    const view = render(<><DestinationPicker {...initial} workspaceError="Workspace unavailable" onRetryWorkspaces={vi.fn()} />
      <button>Elsewhere</button></>)
    const retry = screen.getByRole('button', { name: 'dest.retry' })
    retry.focus()
    view.rerender(<><DestinationPicker {...initial} workspaceError="Workspace unavailable" loading onRetryWorkspaces={vi.fn()} />
      <button>Elsewhere</button></>)
    expect(document.activeElement).toBe(retry)
    const workspaces = result === 'empty' ? [] : initial.workspaces.map(row => ({ ...row, available: result === 'available' }))
    const target = screen.getByRole('button', { name: result === 'empty' ? 'dest.scope' : 'dest.workspace' })
    const focus = vi.spyOn(target, 'focus')
    view.rerender(<><DestinationPicker {...initial} workspaces={workspaces} /><button>Elsewhere</button></>)
    expect(document.activeElement).toBe(target)
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(screen.queryByRole('button', { name: 'dest.retry' })).toBeNull()
    expect({ result, focused: target.getAttribute('aria-label'), text: target.textContent }).toMatchSnapshot()
    view.rerender(<><DestinationPicker {...initial} workspaceError="Workspace unavailable" loading onRetryWorkspaces={vi.fn()} />
      <button>Elsewhere</button></>)
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    view.rerender(<><DestinationPicker {...initial} workspaces={workspaces} /><button>Elsewhere</button></>)
    expect(document.activeElement).toBe(elsewhere)
  },
)
