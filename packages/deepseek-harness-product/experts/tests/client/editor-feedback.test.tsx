// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import { zipSync } from 'fflate'
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { CustomExpertEditor } from '../../src/client/custom-editor.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { AgencyCatalogRemote } from '../../src/client/remote.ts'
import { TeamEditor } from '../../src/client/team-editor.tsx'
import { TeamConfirm } from '../../src/client/team-shared.tsx'
import { TeamLocaleContext } from '../../src/client/team-locale.ts'
import { TEAM_CSS } from '../../src/client/team-style.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import { teamText } from '../../src/team-i18n.ts'
import type { TeamSnapshot } from '../../src/team-contract.ts'
import * as packageFiles from '../../src/client/package-files.ts'

const ctx = new Context()
const locale = new LocaleRuntime(ctx)
locale.register('agency', { en, zh })
locale.setLocale('zh')
afterEach(() => { cleanup(); locale.setLocale('zh'); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(async () => { await ctx.fiber.dispose() })

const expert = { name: 'Reviewer', description: 'Review code', division: 'specialized', prompt: 'Keep {{literal}}.' }
const unused = (): Promise<never> => Promise.reject(new Error('Unexpected remote call'))

function editor(save: AgencyCatalogRemote['saveCustomExpert'] = unused,
  content: React.ComponentProps<typeof CustomExpertEditor>['expert'] = expert, signal?: AbortSignal) {
  const remote = { getCatalog: vi.fn<AgencyCatalogRemote['getCatalog']>(unused), importExpert: vi.fn(unused), exportExpert: unused,
    getCustomExpert: vi.fn<AgencyCatalogRemote['getCustomExpert']>(unused), saveCustomExpert: save, deleteCustomExpert: unused }
  const props = { expert: content, enabled: false, revision: 1, divisions: ['specialized'], remote, ...signal ? { signal } : {},
    t: locale.bind('agency'), prepareSave: () => vi.fn(), onClose: vi.fn() }
  const view = render(<CustomExpertEditor {...props} locale="zh" />)
  return { ...view, remote, changeLanguage(language: 'zh' | 'en' = 'en') {
    locale.setLocale(language)
    view.rerender(<CustomExpertEditor {...props} locale={language} />)
  } }
}

it.each(['zh', 'en'] as const)('returns focus after choosing an avatar and removing attachments in %s', async (language) => {
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockResolvedValue({ ok: true,
    value: { experts: [], enabled: [], revision: 2 } })
  const view = editor(save, { ...expert, resources: { 'assets/a.bin': 'AAE=', 'references/b.md': 'dGVzdA==', 'references/c.md': 'dGVzdA==' } })
  view.changeLanguage(language)
  const text = language === 'zh' ? zh : en
  const avatar = screen.getByRole('button', { name: text['custom.changeAvatar'] })
  fireEvent.click(avatar)
  const choice = screen.getByRole('button', { name: `${text['custom.avatar']} 2` })
  choice.focus()
  fireEvent.click(choice)
  expect(document.activeElement).toBe(avatar)
  expect(avatar.getAttribute('aria-expanded')).toBe('false')
  const remove = (path: string) => screen.getByRole('button', { name: `${text['custom.removeAttachment']}: ${path}` })
  const next = remove('references/c.md')
  const first = remove('assets/a.bin')
  for (const [path, target] of [['references/b.md', next], ['references/c.md', first],
    ['assets/a.bin', screen.getByRole('button', { name: text['custom.attachments'] })]] as const) {
    const button = remove(path)
    button.focus()
    fireEvent.click(button)
    expect(document.activeElement).toBe(target)
    expect(target.getAttribute('data-dsh-automatic-focus')).toBe('')
    expect(screen.queryByRole('button', { name: `${text['custom.removeAttachment']}: ${path}` })).toBeNull()
  }
  expect({ focused: document.activeElement?.textContent, empty: screen.getByText(text['custom.resourcesHint']).textContent }).toMatchSnapshot()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: text['custom.save'] })) })
  expect(save.mock.calls[0]?.[0]).toMatchObject({ avatar: 1, resources: {}, prompt: expert.prompt })
})

it.each((['zh', 'en'] as const).flatMap(language => [false, true].map(elsewhere => ({ language, elsewhere }))))(
  'continues editing expert instructions after applying a template in $language (elsewhere=$elsewhere)', ({ language, elsewhere }) => {
    const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>(unused)
    const view = editor(save)
    view.changeLanguage(language)
    const text = language === 'zh' ? zh : en
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: text['custom.prompt'] })
    fireEvent.change(prompt, { target: { value: '' } })
    const template = screen.getByRole('button', { name: text['custom.template'] })
    const description = screen.getByRole<HTMLInputElement>('textbox', { name: text['custom.description'] })
    template.focus()
    if (elsewhere) {
      description.focus()
      description.setSelectionRange(2, 5)
    }
    fireEvent.click(template)
    expect(document.activeElement).toBe(elsewhere ? description : prompt)
    expect(prompt.value).toBe(text['custom.templateText'])
    expect(template.isConnected).toBe(false)
    expect(description.value).toBe(expert.description)
    if (elsewhere) expect([description.selectionStart, description.selectionEnd]).toEqual([2, 5])
    expect(save).not.toHaveBeenCalled()
    expect(view.remote.importExpert).not.toHaveBeenCalled()
    expect({ focused: document.activeElement?.getAttribute('aria-label'), prompt: prompt.value }).toMatchSnapshot()
  },
)

it.each([false, true])('marks only the submitted expert save action as busy (enable: %s)', async (enabled) => {
  const first = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['saveCustomExpert']>>>()
  const retry = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['saveCustomExpert']>>>()
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  const view = editor(save)
  onTestFinished(() => {
    view.unmount()
    first.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
    retry.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
  })
  const action = enabled ? 'custom.saveEnable' : 'custom.save'
  const other = enabled ? 'custom.save' : 'custom.saveEnable'
  const active = screen.getByRole<HTMLButtonElement>('button', { name: zh[action] })
  const sibling = screen.getByRole<HTMLButtonElement>('button', { name: zh[other] })
  const category = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.division'] })
  const categoryLabel = category.textContent
  active.focus()
  act(() => { fireEvent.click(active); fireEvent.click(sibling); fireEvent.click(active) })
  expect(save).toHaveBeenCalledOnce()
  expect(category.disabled).toBe(false)
  expect(category.getAttribute('aria-disabled')).toBe('true')
  expect(category.classList.contains('product-control-pending')).toBe(true)
  expect(category.textContent).toBe(categoryLabel)
  expect(category.getAttribute('aria-busy')).toBe('true')
  expect(save.mock.calls[0]?.[1]).toBe(enabled)
  expect(screen.getByRole('button', { name: zh['custom.saving'] })).toBe(active)
  expect(screen.getByRole('button', { name: zh[other] })).toBe(sibling)
  expect(active.getAttribute('aria-busy')).toBe('true')
  expect(sibling.getAttribute('aria-busy')).toBe('false')
  for (const button of [active, sibling]) {
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.classList.contains('product-control-pending')).toBe(true)
  }
  expect(document.activeElement).toBe(active)
  view.changeLanguage()
  expect(screen.getByRole('button', { name: en['custom.saving'] })).toBe(active)
  expect(screen.getByRole('button', { name: en[other] })).toBe(sibling)
  expect({ footer: active.closest('footer')!.textContent, focused: document.activeElement?.textContent }).toMatchSnapshot('pending expert save actions')
  await act(async () => { first.reject(new Error('Save unavailable')) })
  expect(document.activeElement).toBe(active)
  const notice = screen.getByRole('alert')
  fireEvent.click(active)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(within(sibling).getByText(en[other]).getAttribute('aria-hidden')).toBe('false')
  expect(active.getAttribute('aria-busy')).toBe('true')
  expect(sibling.getAttribute('aria-busy')).toBe('false')
  await act(async () => { retry.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: en[action] })).toBe(active)
  expect(active.disabled).toBe(false)
  expect(sibling.disabled).toBe(false)
  expect(category.disabled).toBe(false)
  expect(category.classList.contains('product-control-pending')).toBe(false)
  expect(save).toHaveBeenCalledTimes(2)
})

it.each(['Delete', 'Enable team and required experts'])('retains %s confirmation labels, controls and errors through retry', (label) => {
  const confirm = vi.fn(), close = vi.fn()
  const content = (busy: boolean, error?: string) => <TeamLocaleContext.Provider value="en">
    <TeamConfirm title="Confirm team action" label={label} busy={busy} error={error} onConfirm={confirm} onCancel={close} />
  </TeamLocaleContext.Provider>
  const view = render(content(false))
  const action = screen.getByRole<HTMLButtonElement>('button', { name: label })
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  const normal = within(action).getByText(label), pending = within(action).getByText('Working…')
  action.focus()
  view.rerender(content(true, 'Write temporarily unavailable'))
  const error = screen.getByRole('alert')
  expect(screen.getByRole('button', { name: 'Working…' })).toBe(action)
  expect(screen.getByRole('button', { name: 'Cancel' })).toBe(cancel)
  expect(within(action).getByText(label)).toBe(normal)
  expect(within(action).getByText('Working…')).toBe(pending)
  expect(normal.getAttribute('aria-hidden')).toBe('true')
  expect(pending.getAttribute('aria-hidden')).toBe('false')
  expect(document.activeElement).toBe(action)
  fireEvent.click(action); fireEvent.click(cancel); fireEvent.keyDown(action, { key: 'Escape' })
  expect(confirm).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  view.rerender(content(false, 'Write temporarily unavailable'))
  expect(screen.getByRole('button', { name: label })).toBe(action)
  expect(screen.getByRole('alert')).toBe(error)
  view.rerender(content(true, 'Write temporarily unavailable'))
  expect(screen.getByRole('alert')).toBe(error)
  expect(document.activeElement).toBe(action)
  expect({ label, busy: action.getAttribute('aria-busy'), disabled: action.disabled,
    hidden: normal.getAttribute('aria-hidden'), pending: pending.textContent, cancel: cancel.textContent, error: error.textContent }).toMatchSnapshot()
  view.rerender(content(false))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: label })).toBe(action)
  fireEvent.click(action)
  expect(confirm).toHaveBeenCalledOnce()
})

it.each(['importZip', 'importDirectory', 'attachments'] as const)('reports only %s as busy while reading files and preserves the save controls', async (action) => {
  const read = Promise.withResolvers<ArrayBuffer>()
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>(unused)
  const view = editor(save)
  onTestFinished(() => { view.unmount(); read.resolve(new ArrayBuffer(0)) })
  const primary = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.saveEnable'] })
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.cancel'] })
  const button = screen.getByRole<HTMLButtonElement>('button', { name: zh[`custom.${action}`] })
  const category = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.division'] })
  const file = Object.assign(new File(['test'], action === 'importZip' ? 'expert.zip' : action === 'importDirectory' ? 'manifest.json' : '中文模板.txt'),
    { arrayBuffer: vi.fn(() => read.promise) })
  const input = screen.getByLabelText<HTMLInputElement>(zh[`custom.${action}`])
  const picker = vi.spyOn(input, 'click')
  button.focus()
  fireEvent.change(input, { target: { files: [file] } })
  expect(screen.getByRole('button', { name: zh['custom.saveEnable'] })).toBe(primary)
  expect(primary.disabled).toBe(false)
  expect(primary.getAttribute('aria-disabled')).toBe('true')
  expect(primary.getAttribute('aria-busy')).toBe('false')
  expect(primary.classList.contains('product-control-pending')).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(button)
  fireEvent.click(button)
  expect(picker).not.toHaveBeenCalled()
  expect(button.classList.contains('product-control-pending')).toBe(true)
  expect(category.disabled).toBe(false)
  expect(category.getAttribute('aria-disabled')).toBe('true')
  expect(category.classList.contains('product-control-pending')).toBe(true)
  expect(category.getAttribute('aria-busy')).toBe('true')
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  fireEvent.click(cancel)
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(save).not.toHaveBeenCalled()
  view.changeLanguage()
  expect(screen.getByRole('button', { name: en['custom.saveEnable'] })).toBe(primary)
  expect(file.arrayBuffer).toHaveBeenCalledOnce()
  expect({ action: button.textContent, primary: primary.textContent, saving: primary.getAttribute('aria-busy'),
    focused: document.activeElement?.textContent }).toMatchSnapshot()
  await act(async () => { read.reject(new Error('File read interrupted')) })
  expect((await screen.findByRole('alert')).textContent).toBe('File read interrupted')
  expect(primary.disabled).toBe(false)
  expect(category.disabled).toBe(false)
  expect(button.getAttribute('aria-busy')).toBe('false')
  expect(document.activeElement).toBe(button)
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', expert.prompt)
  expect(view.remote.importExpert).not.toHaveBeenCalled()
})

it('translates expert validation feedback without losing the draft or dispatching a save', () => {
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>(unused)
  const view = editor(save)
  fireEvent.change(screen.getByRole('textbox', { name: zh['custom.prompt'] }), { target: { value: '   ' } })
  fireEvent.click(screen.getByRole('button', { name: zh['custom.save'] }))
  expect(screen.getByRole('alert').textContent).toBe(zh['custom.instructionsInvalid'])
  expect(screen.getByRole('alert').closest('footer')).not.toBeNull()
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toBe(en['custom.instructionsInvalid'])
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', '   ')
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
})

it('keeps an expert save error in place until the retry succeeds', async () => {
  const response = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['saveCustomExpert']>>>()
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockRejectedValueOnce(new Error('Save unavailable')).mockReturnValue(response.promise)
  const view = editor(save)
  onTestFinished(() => { view.unmount(); response.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } }) })
  fireEvent.click(screen.getByRole('button', { name: zh['custom.save'] }))
  const notice = await screen.findByRole('alert')
  const help = notice.parentElement!.querySelector('.aag-note')!
  expect(help.getAttribute('aria-hidden')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: zh['custom.save'] }))
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('textbox', { name: zh['custom.prompt'] })).toHaveProperty('value', expert.prompt)
  await act(async () => { response.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(help.isConnected).toBe(true)
  expect(help.getAttribute('aria-hidden')).toBe('false')
  expect(save).toHaveBeenCalledTimes(2)
})

it('translates conflict recovery after a delayed save without repeating the write or discarding the draft', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['saveCustomExpert']>>>()
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>(() => pending.promise)
  const view = editor(save)
  fireEvent.click(screen.getByRole('button', { name: zh['custom.save'] }))
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.cancel'] })
  expect(cancel.disabled).toBe(false)
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  const primary = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.saving'] })
  expect(primary.disabled).toBe(false)
  expect(primary.getAttribute('aria-disabled')).toBe('true')
  expect(primary.getAttribute('aria-busy')).toBe('true')
  expect(primary.classList.contains('product-control-pending')).toBe(true)
  view.changeLanguage()
  await act(async () => { pending.resolve({ ok: false, error: new RemoteError('experts/conflict', 'Stale revision', {}) }) })
  expect(screen.getByRole('alert').textContent).toBe(en['custom.conflict'])
  expect(screen.getByRole('button', { name: en['custom.reviewLatest'] })).toBeDefined()
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', expert.prompt)
  expect(save).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  view.changeLanguage('zh')
  expect(screen.getByRole('alert').textContent).toBe(zh['custom.conflict'])
  expect(save).toHaveBeenCalledOnce()
})

it('retains expert conflict review focus and the draft throughout a repeated read', async () => {
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>().mockResolvedValue({ ok: false,
    error: new RemoteError('experts/conflict', 'Stale revision', {}) })
  const view = editor(save)
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  onTestFinished(() => { view.unmount(); pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } }) })
  view.remote.getCatalog.mockReturnValue(pending.promise)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['custom.save'] })) })
  const notice = screen.getByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.reviewLatest'] })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByLabelText(zh['custom.prompt'])).toHaveProperty('value', expert.prompt)
  expect(view.remote.getCatalog).toHaveBeenCalledOnce()
  await act(async () => { pending.reject(new Error('Review unavailable')) })
  expect(screen.getByRole('button', { name: zh['custom.reviewLatest'] })).toBe(retry)
  expect(retry.getAttribute('aria-disabled')).toBe('false')
  expect(document.activeElement).toBe(retry)
  expect(notice.textContent).toBe('Review unavailable')
})

it.each(['success', 'failure', 'cancellation'] as const)('retains expert comparison during a reread ending in %s', async (outcome) => {
  const slug = 'custom-00000000-0000-4000-8000-000000000001'
  const previous = { ...expert, slug, prompt: 'Previous server instructions.' }
  const latest = { ...previous, prompt: 'Latest server instructions.' }
  const summary = { slug, name: expert.name, nameEn: expert.name, description: expert.description, descriptionEn: '',
    division: expert.division, divisionZh: '其他', custom: true, emoji: '🔎', avatar: 0 }
  const catalog = { experts: [summary], enabled: [], revision: 2 }
  const current = { ...catalog, revision: 3 }
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>()
    .mockResolvedValueOnce({ ok: false, error: new RemoteError('experts/conflict', 'Stale revision', {}) })
    .mockResolvedValue({ ok: true, value: current })
  const controller = new AbortController()
  const view = editor(save, { ...expert, slug }, controller.signal)
  onTestFinished(() => { view.unmount(); pending.resolve({ ok: true, value: current }) })
  view.remote.getCatalog.mockResolvedValueOnce({ ok: true, value: catalog }).mockResolvedValueOnce({ ok: true, value: catalog })
    .mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, value: current })
  view.remote.getCustomExpert.mockResolvedValueOnce({ ok: true, value: previous }).mockResolvedValue({ ok: true, value: latest })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['custom.saveChanges'] })) })
  const read = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.reviewLatest'] })
  await act(async () => { fireEvent.click(read) })
  const content = screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh['custom.latestContent'] })
  const keep = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.keepDraft'] })
  const useLatest = screen.getByRole<HTMLButtonElement>('button', { name: zh['custom.useLatest'] })
  read.focus()
  act(() => { read.click(); keep.click(); useLatest.click(); read.click() })
  expect(view.remote.getCatalog).toHaveBeenCalledTimes(3)
  expect(screen.getByRole('textbox', { name: zh['custom.latestContent'] })).toBe(content)
  expect(content.value).toBe(previous.prompt)
  for (const button of [keep, useLatest]) {
    expect(button.isConnected).toBe(true)
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
  }
  expect(document.activeElement).toBe(read)
  expect(screen.getByRole('button', { name: zh['custom.saveChanges'] })).toHaveProperty('disabled', true)
  view.changeLanguage()
  expect(screen.getByRole('textbox', { name: en['custom.latestContent'] })).toBe(content)
  expect({ content: content.value, focused: document.activeElement === read,
    keep: keep.getAttribute('aria-disabled'), useLatest: useLatest.getAttribute('aria-disabled') }).toMatchSnapshot()
  content.focus()
  if (outcome === 'cancellation') {
    controller.abort()
    await act(async () => { pending.resolve({ ok: true, value: current }) })
    expect(document.activeElement).toBe(read)
    expect(content.isConnected).toBe(false)
    expect(screen.queryByRole('button', { name: en['custom.useLatest'] })).toBeNull()
    expect(screen.getByRole('button', { name: en['custom.saveChanges'] })).toHaveProperty('disabled', true)
    expect(save).toHaveBeenCalledOnce()
    return
  }
  if (outcome === 'failure') {
    await act(async () => { pending.reject(new Error('Review unavailable')) })
    expect(document.activeElement).toBe(read)
    expect(content.isConnected).toBe(false)
    expect(screen.queryByRole('button', { name: en['custom.keepDraft'] })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Review unavailable')
    expect(screen.getByRole('button', { name: en['custom.saveChanges'] })).toHaveProperty('disabled', true)
    await act(async () => { fireEvent.click(read) })
  } else {
    await act(async () => { pending.resolve({ ok: true, value: current }) })
    expect(document.activeElement).toBe(content)
  }
  expect(screen.getByRole('textbox', { name: en['custom.latestContent'] })).toHaveProperty('value', latest.prompt)
  fireEvent.click(screen.getByRole('button', { name: en['custom.useLatest'] }))
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: en['custom.name'] }))
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', latest.prompt)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['custom.saveChanges'] })) })
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: latest.prompt }), false,
    current.revision, expect.any(AbortSignal))
})

it('translates invalid package feedback without reading the package again', async () => {
  const view = editor()
  const bytes = new TextEncoder().encode('{broken manifest')
  const read = vi.fn(async () => bytes.buffer)
  const file = Object.assign(new File([bytes], 'manifest.json'), { arrayBuffer: read })
  fireEvent.change(screen.getByLabelText(zh['custom.importDirectory']), { target: { files: [file] } })
  expect((await screen.findByRole('alert')).textContent).toBe(zh['custom.packageInvalid'])
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toBe(en['custom.packageInvalid'])
  expect(read).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', expert.prompt)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
})

it('translates attachment validation while keeping the original resources and instructions', async () => {
  const view = editor()
  const read = vi.fn(async () => new ArrayBuffer(0))
  const file = Object.assign(new File([], 'NUL.txt'), { arrayBuffer: read })
  fireEvent.change(screen.getByLabelText(zh['custom.attachments']), { target: { files: [file] } })
  expect((await screen.findByRole('alert')).textContent).toBe(zh['custom.packageInvalid'])
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toBe(en['custom.packageInvalid'])
  expect(read).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', expert.prompt)
})

it.each(['prompt', 'agents'] as const)('rejects an oversized UTF-8 %s before saving and preserves the draft', async (field) => {
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>(unused)
  const view = editor(save)
  const text = '中'.repeat(44_000)
  fireEvent.change(screen.getByLabelText(zh[field === 'prompt' ? 'custom.prompt' : 'custom.agents']), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: zh['custom.save'] }))
  await screen.findByRole('alert')
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByLabelText(zh[field === 'prompt' ? 'custom.prompt' : 'custom.agents'])).toHaveProperty('value', text)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot('English instruction validation')
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(en[field === 'prompt' ? 'custom.prompt' : 'custom.agents']), { target: { value: 'Shortened instructions.' } })
  save.mockResolvedValueOnce({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
  fireEvent.click(screen.getByRole('button', { name: en['custom.save'] }))
  await act(async () => {})
  expect(save).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['prompt', 'agents'] as const)('does not export a ZIP containing an oversized UTF-8 %s', async (field) => {
  editor()
  const download = vi.spyOn(packageFiles, 'downloadPackage').mockImplementation(() => {})
  const text = '中'.repeat(44_000)
  fireEvent.change(screen.getByLabelText(zh[field === 'prompt' ? 'custom.prompt' : 'custom.agents']), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: zh['custom.exportZip'] }))
  expect(download).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  expect(screen.getByLabelText(zh[field === 'prompt' ? 'custom.prompt' : 'custom.agents'])).toHaveProperty('value', text)
  fireEvent.change(screen.getByLabelText(zh[field === 'prompt' ? 'custom.prompt' : 'custom.agents']), { target: { value: 'Shortened instructions.' } })
  fireEvent.click(screen.getByRole('button', { name: zh['custom.exportZip'] }))
  expect(download).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the edited expert after a ZIP directory conflict and blocks remote import', async () => {
  const view = editor()
  fireEvent.change(screen.getByRole('textbox', { name: zh['custom.prompt'] }), { target: { value: '保留编辑内容 {{literal}}' } })
  const encode = (text: string) => new TextEncoder().encode(text)
  const bytes = new Uint8Array(zipSync({
    'replacement/manifest.json': encode(JSON.stringify({ worker: { suggested_name: 'replacement' } })),
    'replacement/config/SOUL.md': encode('Replace the current expert.'),
    'replacement/References/': new Uint8Array(),
    'replacement/references/说明.md': encode('Conflicting directory name.'),
  }))
  const file = Object.assign(new File([bytes], 'expert.zip'), { arrayBuffer: vi.fn(async () => bytes.buffer) })
  fireEvent.change(screen.getByLabelText(zh['custom.importZip']), { target: { files: [file] } })
  expect((await screen.findByRole('alert')).textContent).toBe(zh['custom.packageInvalid'])
  expect(screen.getByRole('textbox', { name: zh['custom.prompt'] })).toHaveProperty('value', '保留编辑内容 {{literal}}')
  expect(screen.getByRole('textbox', { name: zh['custom.name'] })).toHaveProperty('value', expert.name)
  expect(screen.getByRole('button', { name: zh['custom.save'] })).toHaveProperty('disabled', false)
  expect(view.remote.importExpert).not.toHaveBeenCalled()
})

it.each([
  { cause: new packageFiles.PackageTransferError('custom.packageInvalid'), key: 'custom.packageInvalid' as const },
  { cause: new Error('Synthetic download failure') },
])('keeps the editor and its draft usable after ZIP export fails: $cause', ({ cause, key }) => {
  const download = vi.spyOn(packageFiles, 'downloadPackage').mockImplementation(() => { throw cause })
  const view = editor()
  fireEvent.click(screen.getByRole('button', { name: zh['custom.exportZip'] }))
  expect(screen.getByRole('alert').textContent).toBe(key ? zh[key] : cause.message)
  expect(screen.getByRole('alert').closest('footer')).not.toBeNull()
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toBe(key ? en[key] : cause.message)
  expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', expert.prompt)
  expect(download).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: en['custom.save'] })).toHaveProperty('disabled', false)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
})

it('clears a failed ZIP export after a successful retry without changing the expert draft', () => {
  const download = vi.spyOn(packageFiles, 'downloadPackage').mockImplementationOnce(() => { throw new Error('Download unavailable') })
    .mockImplementation(() => {})
  editor()
  fireEvent.click(screen.getByRole('button', { name: zh['custom.exportZip'] }))
  expect(screen.getByRole('alert').textContent).toBe('Download unavailable')
  fireEvent.click(screen.getByRole('button', { name: zh['custom.exportZip'] }))
  expect(download).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox', { name: zh['custom.prompt'] })).toHaveProperty('value', expert.prompt)
  expect(screen.getByRole('button', { name: zh['custom.save'] })).toHaveProperty('disabled', false)
})

it('blocks an expert ZIP after editing pushes the complete package over the byte limit and permits repair', () => {
  const base = { ...expert, slug: 'bounded-expert' }
  const overhead = Object.values(packageFiles.draftPackageFiles(base))
    .reduce((sum, encoded) => sum + packageFiles.base64ByteLength(encoded), 0)
  const input = { ...base, resources: { 'assets/中文模板.bin': Buffer.alloc(32 * 1024 * 1024 - overhead).toString('base64') } }
  const create = vi.fn(() => 'blob:bounded-expert-test')
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = editor(unused, input)
  const prompt = expert.prompt + 'x'
  fireEvent.change(screen.getByRole('textbox', { name: zh['custom.prompt'] }), { target: { value: prompt } })
  fireEvent.click(screen.getByRole('button', { name: zh['custom.exportZip'] }))
  expect(screen.getByRole('alert').textContent).toBe(zh['custom.packageTooLarge'])
  expect(create).not.toHaveBeenCalled()
  expect(click).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: zh['custom.prompt'] })).toHaveProperty('value', prompt)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot('Chinese complete-package size limit')
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot('English complete-package size limit')
  fireEvent.click(screen.getByRole('button', { name: `${en['custom.removeAttachment']}: assets/中文模板.bin` }))
  vi.useFakeTimers()
  try {
    fireEvent.click(screen.getByRole('button', { name: en['custom.exportZip'] }))
    expect(create).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('textbox', { name: en['custom.prompt'] })).toHaveProperty('value', prompt)
    expect(screen.getByRole('button', { name: en['custom.saveChanges'] })).toHaveProperty('disabled', false)
  } finally { vi.runOnlyPendingTimers(); vi.useRealTimers() }
})

function teamEditor(save: React.ComponentProps<typeof TeamEditor>['save'] = unused,
  refresh: () => Promise<TeamSnapshot> = unused, initial: React.ComponentProps<typeof TeamEditor>['initial'] = TEST_TEAMS[0],
  signal?: AbortSignal) {
  const props = { initial, experts: [], enabled: false, enabledExperts: [], save, refresh, close: vi.fn(), ...signal ? { signal } : {} }
  const view = render(<TeamLocaleContext.Provider value="zh"><TeamEditor {...props} /></TeamLocaleContext.Provider>)
  return { ...view, changeLanguage(language: 'zh' | 'en' = 'en') {
    view.rerender(<TeamLocaleContext.Provider value={language}><TeamEditor {...props} /></TeamLocaleContext.Provider>)
  } }
}

it('retains the other example fields when removing or adding a team example', () => {
  teamEditor(unused, unused, { ...TEST_TEAMS[0], examples: ['示例一', '示例二', '示例三'] })
  const last = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '任务示例3' })
  act(() => { last.focus(); last.setSelectionRange(1, 2) })
  fireEvent.click(screen.getAllByRole('button', { name: '移除此示例' })[0])
  expect(screen.getByRole('textbox', { name: '任务示例2' })).toBe(last)
  expect(last.selectionStart).toBe(1)
  expect(last.selectionEnd).toBe(2)
  fireEvent.change(last, { target: { value: '修改示例三' } })
  expect(screen.getByRole('textbox', { name: '任务示例2' })).toBe(last)
  fireEvent.click(screen.getByRole('button', { name: '添加示例' }))
  expect(screen.getByRole('textbox', { name: '任务示例2' })).toBe(last)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '任务示例3' }).value).toBe('')
})

it.each(['zh', 'en'] as const)('keeps focus beside removed team members and in new or remaining examples in %s', (language) => {
  const view = teamEditor(unused, unused, { ...TEST_TEAMS[0], examples: ['First task', 'Second task', 'Third task'] })
  view.changeLanguage(language)
  const text = (key: string) => teamText(language, key)
  const members = screen.getAllByRole('button', { name: text('删除成员 {0}').replace('{0}', text('成员已失效')) })
  const add = screen.getByRole('button', { name: text('添加成员') })
  for (const [button, target] of [[members[1], members[2]], [members[2], members[0]], [members[0], add]]) {
    button.focus()
    fireEvent.click(button)
    expect(document.activeElement).toBe(target)
  }
  const first = screen.getByRole<HTMLTextAreaElement>('textbox', { name: `${text('任务示例')}1` })
  const last = screen.getByRole<HTMLTextAreaElement>('textbox', { name: `${text('任务示例')}3` })
  for (const target of [last, first]) {
    const button = screen.getAllByRole('button', { name: text('移除此示例') })[1]
    button.focus()
    fireEvent.click(button)
    expect(document.activeElement).toBe(target)
  }
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text('移除此示例') }).disabled).toBe(true)
  const addExample = screen.getByRole('button', { name: text('添加示例') })
  for (const index of [2, 3]) {
    addExample.focus()
    fireEvent.click(addExample)
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: `${text('任务示例')}${index}` })
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: `New task ${index}` } })
  }
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text('添加示例') }).disabled).toBe(true)
  expect({ focused: document.activeElement?.getAttribute('aria-label'), retained: first.value }).toMatchSnapshot()
})

it.each([false, true])('marks only the submitted team save action as busy (enable: %s)', async (enabled) => {
  const first = Promise.withResolvers<undefined>()
  const retry = Promise.withResolvers<undefined>()
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  const view = teamEditor(save, unused, { ...TEST_TEAMS[0], id: undefined })
  render(<style>{TEAM_CSS}</style>)
  onTestFinished(() => { view.unmount(); first.resolve(undefined); retry.resolve(undefined) })
  const action = enabled ? '保存并启用' : '保存'
  const other = enabled ? '保存' : '保存并启用'
  const active = screen.getByRole<HTMLButtonElement>('button', { name: action })
  const sibling = screen.getByRole<HTMLButtonElement>('button', { name: other })
  const preview = screen.getByRole<HTMLButtonElement>('button', { name: '预览' })
  const addExample = screen.getByRole<HTMLButtonElement>('button', { name: '添加示例' })
  const coordinator = screen.getByRole<HTMLButtonElement>('tab', { name: '自定义' })
  const fields = preview.closest('fieldset')!
  const unavailableAppearance = { opacity: getComputedStyle(addExample).opacity, cursor: getComputedStyle(addExample).cursor }
  expect(preview.matches(':disabled')).toBe(false)
  expect(addExample.disabled).toBe(true)
  active.focus()
  act(() => { fireEvent.click(active); fireEvent.click(sibling); fireEvent.click(active) })
  expect(save).toHaveBeenCalledOnce()
  expect(fields.getAttribute('aria-busy')).toBe('true')
  for (const button of [preview, coordinator]) {
    expect(button.matches(':disabled')).toBe(true)
    expect(getComputedStyle(button).opacity).toBe('1')
    expect(getComputedStyle(button).cursor).toBe('progress')
  }
  expect(addExample.disabled).toBe(true)
  expect({ opacity: getComputedStyle(addExample).opacity, cursor: getComputedStyle(addExample).cursor }).toEqual(unavailableAppearance)
  preview.click()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(save.mock.calls[0]?.[1]).toBe(enabled)
  expect(screen.getByRole('button', { name: '正在保存…' })).toBe(active)
  expect(screen.getByRole('button', { name: other })).toBe(sibling)
  expect(active.getAttribute('aria-busy')).toBe('true')
  expect(sibling.getAttribute('aria-busy')).toBe('false')
  for (const button of [active, sibling]) {
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.classList.contains('product-control-pending')).toBe(true)
  }
  expect(document.activeElement).toBe(active)
  view.changeLanguage()
  expect(screen.getByRole('button', { name: teamText('en', '正在保存…') })).toBe(active)
  expect(screen.getByRole('button', { name: teamText('en', other) })).toBe(sibling)
  expect({ footer: active.closest('footer')!.textContent, focused: document.activeElement?.textContent }).toMatchSnapshot('pending team save actions')
  await act(async () => { first.reject(new Error('保存失败，请重试。')) })
  expect(document.activeElement).toBe(active)
  expect(fields.getAttribute('aria-busy')).toBe('false')
  expect(preview.matches(':disabled')).toBe(false)
  expect(addExample.disabled).toBe(true)
  const notice = screen.getByRole('alert')
  fireEvent.click(active)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(within(sibling).getByText(teamText('en', other)).getAttribute('aria-hidden')).toBe('false')
  expect(active.getAttribute('aria-busy')).toBe('true')
  expect(sibling.getAttribute('aria-busy')).toBe('false')
  await act(async () => { retry.resolve(undefined) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: teamText('en', action) })).toBe(active)
  expect(active.disabled).toBe(false)
  expect(sibling.disabled).toBe(false)
  expect(fields.getAttribute('aria-busy')).toBe('false')
  expect(preview.matches(':disabled')).toBe(false)
  expect(addExample.disabled).toBe(true)
  expect(save).toHaveBeenCalledTimes(2)
})

it('keeps a team save error in place until the retry succeeds', async () => {
  const response = Promise.withResolvers<undefined>()
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>().mockRejectedValueOnce(new Error('保存失败，请重试。')).mockReturnValue(response.promise)
  const view = teamEditor(save)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  const notice = await screen.findByRole('alert')
  const help = notice.parentElement!.querySelector('.aag-note')!
  expect(help.getAttribute('aria-hidden')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(screen.getByRole('alert')).toBe(notice)
  view.changeLanguage()
  expect(notice.textContent).toBe(teamText('en', '保存失败，请重试。'))
  await act(async () => { response.resolve(undefined) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(help.isConnected).toBe(true)
  expect(help.getAttribute('aria-hidden')).toBe('false')
  expect(save).toHaveBeenCalledTimes(2)
})

it.each([
  { field: '场景标签', value: '一,二,三,四', message: '场景标签：最多 3 个，每个标签最多 16 个字符。' },
  { field: '团队名称', value: '   ', message: '请检查字段：{0}。', values: ['团队名称'] },
])('translates team validation for $field while preserving the invalid draft', ({ field, value, message, values }) => {
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>(unused)
  const view = teamEditor(save)
  fireEvent.change(screen.getByRole('textbox', { name: field }), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(screen.getByRole('alert').textContent).toBe(teamText('zh', message, values))
  expect(screen.getByRole('alert').closest('footer')).not.toBeNull()
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toBe(teamText('en', message, values?.map(value => teamText('en', value))))
  expect(screen.getByRole('textbox', { name: teamText('en', field) })).toHaveProperty('value', value)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
})

it.each([new Error('保存失败，请重试。'), null])('translates a delayed team save failure in the current language: %s', async (cause) => {
  const pending = Promise.withResolvers<undefined>()
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>(() => pending.promise)
  const view = teamEditor(save)
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: '取消' })
  expect(cancel.disabled).toBe(false)
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  const primary = screen.getByRole<HTMLButtonElement>('button', { name: '正在保存…' })
  expect(primary.disabled).toBe(false)
  expect(primary.getAttribute('aria-disabled')).toBe('true')
  expect(primary.getAttribute('aria-busy')).toBe('true')
  expect(primary.classList.contains('product-control-pending')).toBe(true)
  view.changeLanguage()
  await act(async () => { pending.reject(cause) })
  expect(screen.getByRole('alert').textContent).toBe(teamText('en', '保存失败，请重试。'))
  expect(screen.getByRole('textbox', { name: teamText('en', '团队名称') })).toHaveProperty('value', TEST_TEAMS[0]?.name)
  expect(save).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  view.changeLanguage('zh')
  expect(screen.getByRole('alert').textContent).toBe('保存失败，请重试。')
  expect(save).toHaveBeenCalledOnce()
})

it('translates a delayed team conflict and refresh failure without repeating either request', async () => {
  const pending = Promise.withResolvers<undefined>()
  const reading = Promise.withResolvers<TeamSnapshot>()
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>(() => pending.promise)
  const refresh = vi.fn(() => reading.promise)
  const view = teamEditor(save, refresh)
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  view.changeLanguage()
  await act(async () => { pending.reject(new RemoteError('experts/conflict', '配置已更新，请读取最新内容后重试。', {})) })
  const notice = screen.getByRole('alert')
  expect(notice.textContent).toBe(teamText('en', '配置已更新，请读取最新内容后重试。'))
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: teamText('en', '读取最新配置') })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  const blockedSave = screen.getByRole<HTMLButtonElement>('button', { name: teamText('en', '保存修改') })
  expect(blockedSave.disabled).toBe(true)
  expect(blockedSave.classList.contains('product-control-pending')).toBe(false)
  expect(blockedSave.getAttribute('aria-busy')).toBe('false')
  view.changeLanguage('zh')
  await act(async () => { reading.reject(new Error('刷新失败。')) })
  expect(screen.getByRole('alert').textContent).toBe('刷新失败。')
  view.changeLanguage()
  expect(screen.getByRole('alert').textContent).toBe(teamText('en', '刷新失败。'))
  expect(screen.getByRole('button', { name: teamText('en', '读取最新配置') })).toHaveProperty('disabled', false)
  expect(document.activeElement).toBe(retry)
  expect(save).toHaveBeenCalledOnce()
  expect(refresh).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
})

it('dispatches one team save when duplicate form submissions arrive before the busy render', async () => {
  const pending = Promise.withResolvers<undefined>()
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>(() => pending.promise)
  teamEditor(save)
  const form = screen.getByRole('textbox', { name: '团队名称' }).closest('form')!
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { pending.reject(new Error('保存失败，请重试。')) })
  expect(screen.getByRole('button', { name: '保存修改' })).toHaveProperty('disabled', false)
  expect(screen.getByRole('textbox', { name: '团队名称' })).toHaveProperty('value', TEST_TEAMS[0]?.name)
})

it.each(['success', 'failure', 'cancellation'] as const)('retains team comparison during a reread ending in %s', async (outcome) => {
  const previous: TeamSnapshot = { teams: [...TEST_TEAMS], enabledTeams: [], enabledExperts: [], revision: 2 }
  const latest = { ...previous, teams: previous.teams.map(team => ({ ...team, description: 'Latest team description' })), revision: 3 }
  const pending = Promise.withResolvers<TeamSnapshot>()
  const refresh = vi.fn<() => Promise<TeamSnapshot>>().mockResolvedValueOnce(previous).mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(latest)
  const save = vi.fn<React.ComponentProps<typeof TeamEditor>['save']>()
    .mockRejectedValueOnce(new RemoteError('experts/conflict', '配置已更新，请读取最新内容后重试。', {}))
    .mockResolvedValue(undefined)
  const controller = new AbortController()
  const view = teamEditor(save, refresh, TEST_TEAMS[0], controller.signal)
  onTestFinished(() => { view.unmount(); pending.resolve(latest) })
  fireEvent.change(screen.getByRole('textbox', { name: '团队名称' }), { target: { value: '保留的团队草稿' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存修改' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取最新配置' })) })
  const useLatest = screen.getByRole<HTMLButtonElement>('button', { name: '使用最新内容' })
  const keep = screen.getByRole<HTMLButtonElement>('button', { name: '保留我的草稿' })
  const content = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '最新主理人提示词' })
  const read = screen.getByRole<HTMLButtonElement>('button', { name: '读取最新配置' })
  read.focus()
  act(() => { read.click(); keep.click(); useLatest.click(); read.click() })
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('textbox', { name: '最新主理人提示词' })).toBe(content)
  for (const button of [keep, useLatest]) {
    expect(button.isConnected).toBe(true)
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
  }
  expect(document.activeElement).toBe(read)
  expect(screen.getByRole('button', { name: '保存修改' })).toHaveProperty('disabled', true)
  view.changeLanguage()
  expect(screen.getByRole('textbox', { name: teamText('en', '最新主理人提示词') })).toBe(content)
  expect({ content: content.value, focused: document.activeElement === read,
    keep: keep.getAttribute('aria-disabled'), useLatest: useLatest.getAttribute('aria-disabled') }).toMatchSnapshot()
  content.focus()
  if (outcome === 'cancellation') {
    controller.abort()
    await act(async () => { pending.resolve(latest) })
    expect(document.activeElement).toBe(read)
    expect(content.isConnected).toBe(false)
    expect(screen.queryByRole('button', { name: teamText('en', '使用最新内容') })).toBeNull()
    expect(screen.getByRole('button', { name: teamText('en', '保存修改') })).toHaveProperty('disabled', true)
    expect(save).toHaveBeenCalledOnce()
    return
  }
  if (outcome === 'failure') {
    await act(async () => { pending.reject(new Error('刷新失败。')) })
    expect(document.activeElement).toBe(read)
    expect(content.isConnected).toBe(false)
    expect(screen.getByRole('alert').textContent).toBe(teamText('en', '刷新失败。'))
    expect(screen.queryByRole('button', { name: teamText('en', '保留我的草稿') })).toBeNull()
    expect(screen.getByRole('button', { name: teamText('en', '保存修改') })).toHaveProperty('disabled', true)
    await act(async () => { fireEvent.click(read) })
  } else {
    await act(async () => { pending.resolve(latest) })
    expect(document.activeElement).toBe(content)
  }
  expect(screen.getByText('Latest team description')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: teamText('en', '保留我的草稿') }))
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: teamText('en', '团队名称') }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: teamText('en', '保存修改') })) })
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: '保留的团队草稿' }), false, latest.revision)
})

it.each(['deleted', 'renamed'] as const)('preserves a new expert draft after another window %s the conflicting name', async (change) => {
  const catalog = { experts: change === 'deleted' ? [] : [{ slug: 'renamed-expert', name: 'Renamed expert', nameEn: '',
    description: '', descriptionEn: '', division: 'specialized', divisionZh: '其他', custom: true, emoji: '🔎', avatar: 0 }],
  enabled: [], revision: 3 }
  const save = vi.fn<AgencyCatalogRemote['saveCustomExpert']>()
    .mockResolvedValueOnce({ ok: false, error: new RemoteError('experts/conflict', 'Stale revision', {}) })
    .mockResolvedValueOnce({ ok: true, value: { ...catalog, revision: 4 } })
  const view = editor(save)
  view.remote.getCatalog.mockResolvedValue({ ok: true, value: catalog })
  const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh['custom.prompt'] })
  fireEvent.change(prompt, { target: { value: 'Keep this unsaved draft.' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['custom.saveEnable'] })) })
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['custom.reviewLatest'] })) })
  const keep = screen.getByRole('button', { name: zh['custom.keepDraft'] })
  keep.focus()
  fireEvent.click(keep)
  expect(screen.getByRole('textbox', { name: zh['custom.prompt'] })).toBe(prompt)
  expect(prompt.value).toBe('Keep this unsaved draft.')
  expect(view.remote.getCustomExpert).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['custom.saveEnable'] })) })
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1]).toEqual([
    expect.objectContaining({ name: expert.name, prompt: prompt.value }), true, 3, expect.any(AbortSignal),
  ])
  expect(save.mock.calls[1]?.[0]).not.toHaveProperty('slug')
})
