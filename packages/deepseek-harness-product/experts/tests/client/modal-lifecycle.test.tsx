// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import React from 'react'
import { zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CategorySelect } from '../../src/client/category-select.ts'
import { CustomExpertEditor } from '../../src/client/custom-editor.ts'
import { LibraryConfirm } from '../../src/client/library-ui.tsx'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgencyCatalogRemote } from '../../src/client/remote.ts'
import { en, zh } from '../../src/client/locales.ts'
import { PromptDialog } from '../../src/client/prompt-dialog.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import { TeamEditor } from '../../src/client/team-editor.tsx'
import { TeamDialog } from '../../src/client/team-shared.tsx'
import { confirmTeamAction } from '../../src/client/team-confirmation.tsx'
import { importExpertPackage } from '../../src/package-transfer.ts'
import { expertPackageFiles } from '../../src/expert-packages.ts'

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals() })

const dialogs = [
  { name: 'prompt', view: (close: () => void) => <PromptDialog title="Prompt" value={{ name: 'Review', prompt: 'Review changes' }} closeLabel="Done" onClose={close} /> },
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

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

it('does not open a team confirmation for an already cancelled operation', async () => {
  const opener = focusOpener()
  const controller = new AbortController()
  controller.abort()
  await expect(confirmTeamAction('保留原始草稿。', 'zh', controller.signal)).resolves.toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it.each(['confirm', 'cancel', 'abort', 'pagehide'] as const)('settles a team confirmation through %s and releases the native modal', async (action) => {
  const opener = focusOpener()
  const controller = new AbortController()
  let pending!: Promise<boolean>
  await act(async () => { pending = confirmTeamAction('保留原始草稿。', 'zh', controller.signal) })
  const dialog = await screen.findByRole('dialog', { name: '确认选择专家团' })
  expect(within(dialog).getByText('保留原始草稿。')).toBeTruthy()
  let accepted!: boolean
  await act(async () => {
    if (action === 'abort') controller.abort()
    else if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'))
    else fireEvent.click(within(dialog).getByRole('button', { name: action === 'confirm' ? '确认' : '取消' }))
    accepted = await pending
  })
  expect(accepted).toBe(action === 'confirm')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true)
})

it.each(['expert', 'team'] as const)('protects %s edits from reload and releases protection after reverting or unmounting', (kind) => {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote operation'))
  const dictionary: Readonly<Record<string, string>> = en
  const view = render(kind === 'expert'
    ? <CustomExpertEditor enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
      remote={{ getCatalog: unused, importExpert: unused, exportExpert: unused,
        getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused }}
      prepareSave={() => vi.fn()} onClose={vi.fn()} />
    : <TeamEditor initial={TEST_TEAMS[0]} experts={[]} enabled={false} enabledExperts={[]}
      save={unused} refresh={unused} close={vi.fn()} />)
  expect(unloadPrevented()).toBe(false)
  const field = screen.getByRole<HTMLInputElement>('textbox', { name: kind === 'expert' ? en['custom.name'] : '团队名称' })
  const initial = field.value
  fireEvent.change(field, { target: { value: '尚未保存的名称' } })
  expect(unloadPrevented()).toBe(true)
  fireEvent.change(field, { target: { value: initial } })
  expect(unloadPrevented()).toBe(false)
  fireEvent.change(field, { target: { value: '继续编辑' } })
  expect(unloadPrevented()).toBe(true)
  view.unmount()
  expect(unloadPrevented()).toBe(false)
})

it('protects unapplied team tags from reload without treating the loaded team as dirty', () => {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote operation'))
  render(<TeamEditor initial={TEST_TEAMS[0]} experts={[]} enabled={false} enabledExperts={[]}
    save={unused} refresh={unused} close={vi.fn()} />)
  expect(unloadPrevented()).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: '场景标签' }), { target: { value: '待保存' } })
  expect(unloadPrevented()).toBe(true)
})

it.each(['expert', 'team'] as const)('protects an unchanged %s during save and releases it after a failed save', async (kind) => {
  let reject!: (error: Error) => void
  const pending = new Promise<never>((_resolve, fail) => { reject = fail })
  const save = vi.fn(() => pending)
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote operation'))
  const dictionary: Readonly<Record<string, string>> = en
  render(kind === 'expert'
    ? <CustomExpertEditor expert={{ name: 'Reviewer', description: 'Review code', division: 'specialized', prompt: 'Review changes' }}
      enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
      remote={{ getCatalog: unused, importExpert: unused, exportExpert: unused,
        getCustomExpert: unused, saveCustomExpert: save, deleteCustomExpert: unused }}
      prepareSave={() => vi.fn()} onClose={vi.fn()} />
    : <TeamEditor initial={TEST_TEAMS[0]} experts={[]} enabled={false} enabledExperts={[]} save={save} refresh={unused} close={vi.fn()} />)
  expect(unloadPrevented()).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: kind === 'expert' ? en['custom.save'] : '保存修改' }))
  expect(save).toHaveBeenCalledOnce()
  expect(unloadPrevented()).toBe(true)
  await act(async () => { reject(new Error('Save unavailable')) })
  expect(unloadPrevented()).toBe(false)
  expect(screen.getByRole('alert').textContent).toContain('Save unavailable')
})

it.each(['disabled', 'pending', 'both'] as const)('closes a %s category menu and requires a new action after enabling', (reason) => {
  const onChange = vi.fn()
  const props = { id: 'division', value: 'engineering', label: 'Category',
    options: [{ value: 'engineering', label: 'Engineering' }], onChange }
  const view = render(<CategorySelect {...props} />)
  const trigger = screen.getByRole('button', { name: 'Category' })
  trigger.focus()
  fireEvent.click(trigger)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.rerender(<CategorySelect {...props} disabled={reason !== 'pending'} pending={reason !== 'disabled'} />)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger).toHaveProperty('disabled', reason !== 'pending')
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  if (reason === 'pending') expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.classList.contains('product-control-pending')).toBe(reason === 'pending')
  fireEvent.click(trigger)
  expect(onChange).not.toHaveBeenCalled()
  view.rerender(<CategorySelect {...props} />)
  expect(screen.getByRole('button', { name: 'Category' })).toBe(trigger)
  expect(trigger.classList.contains('product-control-pending')).toBe(false)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Engineering' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('engineering')
})

for (const dialog of dialogs) {
  it.each(protectedKeys)(`${dialog.name} ignores $name Escape and accepts a plain Escape`, (key) => {
    const close = vi.fn()
    focusOpener()
    render(dialog.view(close))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', ...key })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it(`${dialog.name} preserves composition and its late closing Escape`, () => {
    const close = vi.fn()
    focusOpener()
    render(dialog.view(close))
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

it('focuses the prompt action and restores native entry focus after closing', async () => {
  const opener = focusOpener()
  function Preview() {
    const [open, setOpen] = React.useState(true)
    return open ? <PromptDialog title="Prompt" value={{ name: 'Review', prompt: 'Review changes' }} closeLabel="Done" onClose={() => { setOpen(false) }} /> : null
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
    remote={{ getCatalog: unused, importExpert: async () => { throw new Error('Unexpected package import') }, exportExpert: async () => { throw new Error('Unexpected package export') }, getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused }}
    prepareSave={() => vi.fn()} onClose={close} />)
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
    remote={{ getCatalog, importExpert: async () => { throw new Error('Unexpected package import') }, exportExpert: async () => { throw new Error('Unexpected package export') }, getCustomExpert: unused, saveCustomExpert: save, deleteCustomExpert: unused }}
    prepareSave={() => saved} onClose={vi.fn()} />)
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


it.each([
  { name: 'new expert, absent instructions', agents: undefined, slug: undefined },
  { name: 'new expert, empty instructions', agents: '', slug: undefined },
  { name: 'existing expert, absent instructions', agents: undefined, slug: 'order-expert' },
  { name: 'existing expert, empty instructions', agents: '', slug: 'order-expert' },
])('imports and saves an untouched AgentSpec ZIP without changing its manifest or optional file presence: $name', async ({ agents, slug }) => {
  const manifest = JSON.stringify({ worker: { suggested_name: 'order-expert' }, description: 'Review orders' }, null, 2) + '\n'
  const files = expertPackageFiles('order-expert', { name: 'Order expert', description: 'Review orders', division: 'specialized',
    prompt: 'Review the supplied evidence.', manifest, agents: 'Working rules' })
  if (agents === undefined) delete files['experts/order-expert/config/AGENTS.md']
  else files['experts/order-expert/config/AGENTS.md'] = ''
  const imported = importExpertPackage(files)
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote call'))
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
  const dictionary: Readonly<Record<string, string>> = en
  render(<CustomExpertEditor expert={slug ? { ...imported, slug, prompt: 'Original instructions' } : undefined} enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
    remote={{ getCatalog: unused, importExpert: async () => ({ ok: true, value: imported }), exportExpert: unused,
      getCustomExpert: unused, saveCustomExpert: save, deleteCustomExpert: unused }} prepareSave={() => vi.fn()} onClose={vi.fn()} />)
  const bytes = new Uint8Array(zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path.slice('experts/'.length), new Uint8Array(Buffer.from(content, 'base64'))]))))
  const zip = new File([], 'order-expert.zip')
  Object.defineProperty(zip, 'arrayBuffer', { value: async () => bytes.buffer })
  fireEvent.change(screen.getByLabelText(en['custom.importZip']), { target: { files: [zip] } })
  await waitFor(() => { expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', imported.prompt) })
  fireEvent.click(screen.getByRole('button', { name: en[slug ? 'custom.saveChanges' : 'custom.save'] }))
  await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
  expect(save.mock.calls[0][0].manifest).toBe(manifest)
  expect(expertPackageFiles('order-expert', save.mock.calls[0][0])).toEqual(files)
})

it('imports the same selected ZIP again, clears old errors and uses buttons for all file pickers', async () => {
  const expert = { name: 'Imported', description: 'Imported expert', division: 'specialized', prompt: 'Imported instructions' }
  const importExpert = vi.fn<AgencyCatalogRemote['importExpert']>()
    .mockRejectedValueOnce(new Error('Temporary import failure'))
    .mockResolvedValue({ ok: true, value: expert })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote call'))
  const dictionary: Readonly<Record<string, string>> = en
  const view = render(<CustomExpertEditor enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
    remote={{ getCatalog: unused, importExpert, exportExpert: unused,
      getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused }}
    prepareSave={() => vi.fn()} onClose={vi.fn()} />)
  const input = screen.getByLabelText<HTMLInputElement>(en['custom.importZip'])
  const pick = vi.spyOn(input, 'click')
  fireEvent.click(screen.getByRole('button', { name: en['custom.importZip'] }))
  expect(pick).toHaveBeenCalledOnce()
  expect(input.hidden).toBe(true)
  expect(view.container.querySelectorAll('input[type=file]:not([hidden])')).toHaveLength(0)
  const bytes = new Uint8Array(zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify({ worker: { suggested_name: 'imported' } })), 'config/SOUL.md': new TextEncoder().encode(expert.prompt) }))
  const file = new File([], 'expert.zip')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe('Temporary import failure')
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => { expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', expert.prompt) })
  expect(importExpert).toHaveBeenCalledTimes(2)
  expect(input.value).toBe('')
  expect(screen.queryByRole('alert')).toBeNull()
})


it.each(['unmount', 'employee-change'])('stops local package reads before contacting the host after %s', async (cancel) => {
  const controller = new AbortController()
  const pending = Promise.withResolvers<ArrayBuffer>()
  const first = new File([], 'manifest.json')
  const firstRead = vi.fn(() => pending.promise)
  Object.defineProperty(first, 'arrayBuffer', { value: firstRead })
  const second = new File([], 'SOUL.md')
  const secondRead = vi.fn(async () => new ArrayBuffer(0))
  Object.defineProperty(second, 'arrayBuffer', { value: secondRead })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote call'))
  const importExpert = vi.fn<AgencyCatalogRemote['importExpert']>()
  const dictionary: Readonly<Record<string, string>> = en
  const view = render(<CustomExpertEditor importOnly enabled={false} revision={1} divisions={['specialized']} locale="en" t={key => dictionary[key] ?? key}
    remote={{ getCatalog: unused, importExpert, exportExpert: unused,
      getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused }}
    signal={controller.signal} prepareSave={() => vi.fn()} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(en['custom.importDirectory']), { target: { files: [first, second] } })
  expect(firstRead).toHaveBeenCalledOnce()
  if (cancel === 'unmount') view.unmount()
  else controller.abort()
  await act(async () => { pending.resolve(new ArrayBuffer(0)); await pending.promise })
  expect(secondRead).not.toHaveBeenCalled()
  expect(importExpert).not.toHaveBeenCalled()
})

it('keeps the complete expert draft and reports a duplicate attachment selection before reading or saving', async () => {
  const expert = { slug: 'order-expert', name: '订单专家', description: '订单核对', division: 'specialized', prompt: '保留原始说明 {{literal}}',
    resources: { 'assets/订单模板.bin': 'AAE=' } }
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote call'))
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
  const remote = { getCatalog: unused, importExpert: unused, exportExpert: unused, getCustomExpert: unused,
    saveCustomExpert: save, deleteCustomExpert: unused }
  const saved = vi.fn(), dictionary: Readonly<Record<string, string>> = zh
  render(<CustomExpertEditor expert={expert} enabled={false} revision={1} divisions={['specialized']} locale="zh" t={key => dictionary[key] ?? key}
    remote={remote}
    prepareSave={() => saved} onClose={vi.fn()} />)
  const files = [new File([], '模板.xlsx'), new File([], '模板.xlsx')]
  const reads = files.map((file) => {
    const read = vi.fn(async () => new ArrayBuffer(0))
    Object.defineProperty(file, 'arrayBuffer', { value: read })
    return read
  })
  fireEvent.change(screen.getByLabelText(zh['custom.attachments']), { target: { files } })
  const alert = await screen.findByRole('alert')
  expect({ message: alert.textContent, prompt: screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh['custom.prompt'] }).value,
    attachment: screen.getByText('assets/订单模板.bin').textContent }).toMatchInlineSnapshot(`
      {
        "attachment": "assets/订单模板.bin",
        "message": "专家包无效，请检查 manifest.json、SOUL.md、文件路径及重复文件。",
        "prompt": "保留原始说明 {{literal}}",
      }
    `)
  for (const read of reads) expect(read).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['custom.saveChanges'] }))
  await waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  expect(save).toHaveBeenCalledWith(expect.objectContaining(expert), false, 1, expect.any(AbortSignal))
})
