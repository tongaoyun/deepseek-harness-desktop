// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CategorySelect } from '../../src/client/category-select.ts'
import { CustomExpertEditor } from '../../src/client/custom-editor.ts'
import { LibraryConfirm } from '../../src/client/library-ui.tsx'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgencyCatalogRemote } from '../../src/client/remote.ts'
import { en } from '../../src/client/locales.ts'
import { PromptDialog } from '../../src/client/prompt-dialog.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import { TeamEditor } from '../../src/client/team-editor.tsx'
import { TeamDialog } from '../../src/client/team-shared.tsx'

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals() })

const dialogs = [
  { name: 'prompt', view: (close: () => void, opener: HTMLElement) => <PromptDialog title="Prompt" value={{ name: 'Review', prompt: 'Review changes' }} closeLabel="Done" returnFocus={opener} onClose={close} /> },
  { name: 'confirmation', view: (close: () => void) => <LibraryConfirm title="Confirmation" cancelLabel="Cancel" confirmLabel="Confirm" confirm={vi.fn()} close={close} /> },
  { name: 'team', view: (close: () => void) => <TeamDialog title="Team" close={close}><input aria-label="Team name" /></TeamDialog> },
]
const protectedKeys = [
  { name: 'Control', ctrlKey: true },
  { name: 'Alt', altKey: true },
  { name: 'Meta', metaKey: true },
  { name: 'Shift', shiftKey: true },
  { name: 'repeat', repeat: true },
]

function focusOpener(): HTMLButtonElement {
  const opener = document.createElement('button')
  opener.textContent = 'Open'
  document.body.append(opener)
  opener.focus()
  return opener
}

for (const dialog of dialogs) {
  it.each(protectedKeys)(`${dialog.name} ignores $name Escape and accepts a plain Escape`, (key) => {
    const close = vi.fn()
    render(dialog.view(close, focusOpener()))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', ...key })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it(`${dialog.name} preserves composition and its late closing Escape`, () => {
    const close = vi.fn()
    render(dialog.view(close, focusOpener()))
    const target = screen.getByRole('dialog')
    fireEvent.compositionStart(target)
    fireEvent.keyDown(target, { key: 'Escape', isComposing: false })
    expect(close).not.toHaveBeenCalled()
    fireEvent.compositionEnd(target)
    fireEvent.keyDown(target, { key: 'Escape', isComposing: false })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyUp(target, { key: 'Escape' })
    fireEvent.keyDown(target, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })
}

it('focuses the prompt action and restores the explicit opener after closing', async () => {
  const opener = focusOpener()
  function Preview() {
    const [open, setOpen] = React.useState(true)
    return open ? <PromptDialog title="Prompt" value={{ name: 'Review', prompt: 'Review changes' }} closeLabel="Done" returnFocus={opener} onClose={() => { setOpen(false) }} /> : null
  }
  render(<Preview />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
  expect({ title: screen.getByText('Prompt').textContent,
    prompt: screen.getByRole('textbox'), focusedAction: document.activeElement?.textContent,
  }).toMatchSnapshot()
  fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
  await Promise.resolve()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it('closes only the foreground dialog and restores focus through both layers', async () => {
  const opener = focusOpener()
  function Nested() {
    const [open, setOpen] = React.useState(true)
    const [confirm, setConfirm] = React.useState(false)
    return open ? <TeamDialog title="Team" close={() => { setOpen(false) }}>
      <button data-modal-autofocus onClick={() => { setConfirm(true) }}>Delete team</button>
      {confirm ? <LibraryConfirm title="Delete" cancelLabel="Cancel" confirmLabel="Confirm" confirm={vi.fn()} close={() => { setConfirm(false) }} /> : null}
    </TeamDialog> : null
  }
  render(<Nested />)
  const trigger = screen.getByRole('button', { name: 'Delete team' })
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
  await Promise.resolve()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  await Promise.resolve()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it('keeps a busy confirmation open', () => {
  const close = vi.fn()
  render(<LibraryConfirm title="Saving" cancelLabel="Cancel" confirmLabel="Confirm" busy confirm={vi.fn()} close={close} />)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
})

it('lets the category menu consume Escape before the expert dialog', () => {
  const close = vi.fn()
  render(<TeamDialog title="Team" close={close}>
    <CategorySelect id="category" label="Category" value="engineering" options={[{ value: 'engineering', label: 'Engineering' }]} onChange={vi.fn()} />
  </TeamDialog>)
  const trigger = screen.getByRole('button', { name: 'Category' })
  trigger.focus()
  fireEvent.click(trigger)
  const menu = screen.getByRole('menu')
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(close).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
})

it('keeps the unsaved expert when cancelling discard and closes only after explicit discard', () => {
  const close = vi.fn()
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote mutation'))
  const dictionary: Readonly<Record<string, string>> = en
  render(<CustomExpertEditor enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
    remote={{ getCatalog: unused, getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused }}
    onSaved={vi.fn()} onClose={close} />)
  const prompt = screen.getByRole('textbox', { name: en['custom.prompt'] })
  fireEvent.change(prompt, { target: { value: 'Unsaved instructions' } })
  prompt.focus()
  fireEvent.keyDown(prompt, { key: 'Escape' })
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(document.activeElement).toBe(prompt)
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', 'Unsaved instructions')
  fireEvent.keyDown(prompt, { key: 'Escape' })
  const confirmation = screen.getAllByRole('dialog').at(-1)
  if (!confirmation) throw new Error('Discard confirmation missing')
  fireEvent.click(within(confirmation).getByRole('button', { name: en['custom.discard'] }))
  expect(close).toHaveBeenCalledTimes(1)
})

it('opens conflict review from the native error code even when its wording changes', async () => {
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockResolvedValue({ ok: false,
    error: new RemoteError('experts/conflict', 'Revision is stale', {}) })
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>().mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected call'))
  const saved = vi.fn()
  const dictionary: Readonly<Record<string, string>> = en
  render(<CustomExpertEditor expert={{ name: 'Reviewer', description: 'Review code', division: 'specialized', prompt: 'Check changes' }}
    enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
    remote={{ getCatalog, getCustomExpert: unused, saveCustomExpert: save, deleteCustomExpert: unused }}
    onSaved={saved} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: en['custom.save'] }))
  const review = await screen.findByRole('button', { name: en['custom.reviewLatest'] })
  expect(screen.getByRole('alert').textContent).toBe(en['custom.conflict'])
  expect(saved).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', 'Check changes')
  expect({ notice: screen.getByRole('alert').textContent, recovery: review.textContent,
    draft: screen.getByRole<HTMLTextAreaElement>('textbox', { name: en['custom.prompt'] }).value }).toMatchSnapshot()
  fireEvent.click(review)
  await screen.findByRole('button', { name: en['custom.keepDraft'] })
  expect(getCatalog).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledOnce()
})

it('offers team conflict review by code without relying on Chinese or English keywords', async () => {
  const save = vi.fn().mockRejectedValue(new RemoteError('experts/conflict', 'Revision is stale', {}))
  const refresh = vi.fn().mockResolvedValue({ teams: [], enabledExperts: [], enabledTeams: [], revision: 2 })
  render(<TeamEditor initial={TEST_TEAMS[0]} experts={[]} enabled={false} enabledExperts={[]}
    save={save} refresh={refresh} close={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  const review = await screen.findByRole('button', { name: '读取最新配置' })
  expect(screen.getByRole('alert').textContent).toBe('Revision is stale')
  expect(save).toHaveBeenCalledOnce()
  expect(refresh).not.toHaveBeenCalled()
  fireEvent.click(review)
  await screen.findByText('该专家团已被删除，保留草稿将另存为新团队。')
  expect(refresh).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledOnce()
})
