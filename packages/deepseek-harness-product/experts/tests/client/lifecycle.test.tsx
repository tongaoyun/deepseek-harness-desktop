// @vitest-environment jsdom
/** The mounted expert plugin owns and resets the same data used by its UI contributions. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, type TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { InputTriggerService, type InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { DraftAttachmentId, InsertTextRequest } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionInputShell } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PropsRenderSlots, ScopedStandardSourceBinding, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as Experts from '../../src/client/index.ts'
import type { ExpertClientState } from '../../src/client/client-state.ts'
import type { AgencyCatalogRemote, AgencyTeamsRemote } from '../../src/client/remote.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import { CONTENT_CATEGORIES } from '@deepseek-harness/product/content-categories'
import { teamText } from '../../src/team-i18n.ts'
import { en, zh } from '../../src/client/locales.ts'

afterEach(cleanup)

async function fixture(renderMain: boolean | 'picker' = false, personal = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('locale', new LocaleRuntime(ctx))
  const binding = { session, sessionId: session.sessionId, ctx }
  const scope = vi.fn<() => Context | undefined>(() => undefined)
  const inputFor = vi.fn<(scope: Context) => Experts.ReferenceInsertionTarget>()
  ctx.provide('sessions', { scope,
    sessionOf: (scope: Context) => scope === ctx ? session : undefined,
    binding: (id: ReturnType<typeof SessionId>) => id === session.sessionId ? binding : undefined,
  } as never)
  ctx.provide('conversation', { input: { for: inputFor } } as never)
  ctx.provide('layout', {} as never)
  const startSession = vi.fn<Context['uiWorkspace']['startSession']>()
  ctx.reflect.provide('uiWorkspace', { startSession })
  await ctx.plugin(InputTriggerService).await()
  const sources = new Map<string, InputTriggerSource>()
  const register = ctx.inputTriggers.registerSource.bind(ctx.inputTriggers)
  vi.spyOn(ctx.inputTriggers, 'registerSource').mockImplementation((source) => {
    const dispose = register(source)
    sources.set(source.name, source)
    return () => { dispose(); if (sources.get(source.name) === source) sources.delete(source.name) }
  })
  const unmount = vi.fn(async () => {})
  ctx.provide('remote', { $mount: async () => unmount } as never)
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>().mockResolvedValue({ ok: true, value: { experts: personal ? [{ slug: 'custom-reviewer', name: 'Reviewer', nameEn: 'Reviewer', description: 'Review code', descriptionEn: '', division: 'engineering', divisionZh: '工程', emoji: '🧩', custom: true }] : [], enabled: ['old'], revision: 8 } })
  const getTeams = vi.fn<AgencyTeamsRemote['getTeams']>().mockResolvedValue({ ok: true, value: { teams: [], enabledTeams: ['old'], enabledExperts: ['old'], revision: 8 } })
  const saveCustomExpert = vi.fn<AgencyCatalogRemote['saveCustomExpert']>()
  const deleteCustomExpert = vi.fn<AgencyCatalogRemote['deleteCustomExpert']>()
  const exportExpert = vi.fn<AgencyCatalogRemote['exportExpert']>()
  const importExpert = vi.fn<AgencyCatalogRemote['importExpert']>()
  const getCustomExpert = vi.fn<AgencyCatalogRemote['getCustomExpert']>().mockResolvedValue({ ok: true, value: { slug: 'custom-reviewer', name: 'Reviewer', description: 'Review code', division: 'engineering', prompt: 'Check changes' } })
  const getPrompt = vi.fn<TypertRemoteNamespaceMap['agencyAgents']['getPrompt']>().mockResolvedValue({ ok: true, value: { prompt: 'Check changes' } })
  const setEnabled = vi.fn<Parameters<typeof Experts.writeEnabled>[0]['setEnabled']>()
  ctx.provide('remote.agencyAgents', { getCatalog, getTeams, saveCustomExpert, deleteCustomExpert, exportExpert, importExpert, setEnabled, getCustomExpert, getPrompt } as never)
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
  } }, (props: PropsRenderSlots<'main' | 'conversation.input.left'>) => renderMain === 'picker'
    ? props.renderSlot('conversation.input.left', {})
    : renderMain ? props.renderSlot('main', {}, { entryKey: 'deepseek-harness-experts' }) : null)
  if (renderMain) {
    slots.install(createSlotRenderer()); slots.installLocale(ctx.locale)
    const binding = renderMain === 'picker'
      ? { key: SessionId('picker-session'), ctx, hooks: {}, keyedHooks: {}, props: {} } satisfies ScopedStandardSourceBinding
      : { key: undefined, hooks: {}, keyedHooks: {}, props: {} } satisfies StandardSourceBinding
    const current = createSnapshotStore<StandardSourceBinding>(binding)
    slots.installScope('session', { current, bindingSource: () => current, renderArea: () => null })
  }
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'experts-client': Experts })
  const root = await mkdtemp(join(tmpdir(), 'experts-client-'))
  // The loader watches this file and can close one tick after the owner is
  // disposed. Retry cleanup so a late watcher write cannot make the test
  // itself fail with ENOTEMPTY.
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const path = join(root, 'cordis.yml')
  await writeFile(path, "- name: 'cordis:experts-client'\n")
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const owner = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:experts-client')?.fiber
  if (!owner) throw new Error('Expert client was not loaded')
  await owner.await()
  const cache = slots.entries('main')[0]?.inject?.().cache as ExpertClientState | undefined
  if (!cache) throw new Error('Expert transcript contribution missing')
  await vi.waitFor(() => { expect(cache.catalog.getSnapshot().revision).toBe(8); expect(cache.teams.getSnapshot()?.revision).toBe(8) })
  return { ctx, owner, cache, getCatalog, getTeams, saveCustomExpert, deleteCustomExpert, exportExpert, importExpert,
    getCustomExpert, getPrompt, setEnabled, unmount, slots, sources, startSession, scope, inputFor }
}

it.each([false, true])('preserves personal expert filters after saving (leaves results=%s)', async (leavesResults) => {
  const { ctx, slots, cache, saveCustomExpert } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: t('custom.source') }))
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: t('settings.search') })
  fireEvent.change(search, { target: { value: 'Reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: '研发与集成' }))
  const status = screen.getByRole('button', { name: t('settings.filter.status') })
  fireEvent.click(status)
  fireEvent.click(screen.getByRole('menuitem', { name: t('settings.disabled') }))
  fireEvent.click(screen.getByRole('button', { name: t('custom.edit') }))
  const editor = within(await screen.findByRole('dialog', { name: t('custom.edit') }))
  const nextName = leavesResults ? 'Updated expert' : 'Reviewer updated'
  fireEvent.change(editor.getByRole('textbox', { name: t('custom.name') }), { target: { value: nextName } })
  saveCustomExpert.mockResolvedValue({ ok: true, value: { experts: cache.catalog.getSnapshot().experts.map(expert => ({
    ...expert, name: nextName, nameEn: nextName,
  })), enabled: [], revision: 9 } })
  await act(async () => { fireEvent.click(editor.getByRole('button', { name: t('custom.saveChanges') })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('textbox', { name: t('settings.search') })).toBe(search)
  expect(search.value).toBe('Reviewer')
  expect(screen.getByRole('button', { name: '研发与集成' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: t('settings.filter.status') })).toBe(status)
  expect(status.textContent).toBe(t('settings.disabled'))
  expect(screen.queryByRole('button', { name: t('custom.edit') }) === null).toBe(leavesResults)
  expect({ search: search.value, status: status.textContent, leavesResults }).toMatchSnapshot()
})

it.each([false, true])('recovers focus after a delayed saved expert leaves results without stealing focus (elsewhere=%s)', async (elsewhere) => {
  const { ctx, slots, cache, saveCustomExpert } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: t('custom.source') }))
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: t('settings.search') })
  fireEvent.change(search, { target: { value: 'Reviewer' } })
  const edit = screen.getByRole('button', { name: t('custom.edit') })
  const status = screen.getByRole('button', { name: t('settings.filter.status') })
  edit.focus()
  fireEvent.click(edit)
  const editor = within(await screen.findByRole('dialog', { name: t('custom.edit') }))
  fireEvent.change(editor.getByRole('textbox', { name: t('custom.name') }), { target: { value: 'Updated' } })
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  const accept = cache.catalog.acceptMutation.bind(cache.catalog)
  vi.spyOn(cache.catalog, 'acceptMutation').mockImplementation(async (...args) => {
    await gate.promise
    return accept(...args)
  })
  saveCustomExpert.mockResolvedValue({ ok: true, value: { experts: cache.catalog.getSnapshot().experts.map(expert => ({
    ...expert, name: 'Updated', nameEn: 'Updated',
  })), enabled: [], revision: 9 } })
  await act(async () => { fireEvent.click(editor.getByRole('button', { name: t('custom.saveChanges') })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(edit)
  if (elsewhere) status.focus()
  await act(async () => { gate.resolve(undefined) })
  expect(screen.queryByRole('button', { name: t('custom.edit') })).toBeNull()
  expect(search.value).toBe('Reviewer')
  expect(document.activeElement).toBe(elsewhere ? status : search)
})

it.each(['edit', 'prompt'] as const)('retains expert %s read feedback until the detail retry succeeds', async (action) => {
  const { ctx, slots, getCustomExpert, getPrompt } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCustomExpert']>>>()
  const result = { ok: true as const, value: { slug: 'custom-reviewer', name: 'Reviewer', description: 'Review code', division: 'engineering', prompt: 'Check changes' } }
  const read = action === 'edit' ? getCustomExpert : getPrompt
  read.mockRejectedValueOnce(new Error('Read unavailable')).mockReturnValueOnce(pending.promise)
  const view = render(slots.renderSlot('root', {}))
  onTestFinished(() => { view.unmount(); pending.resolve(result) })
  fireEvent.click(screen.getByRole('tab', { name: t('custom.source') }))
  const button = await screen.findByRole('button', { name: t(action === 'edit' ? 'custom.edit' : 'settings.viewPromptTitle') })
  fireEvent.click(button)
  const notice = await screen.findByRole('alert')
  expect(notice.textContent).toContain('Read unavailable')
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(read).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(button.isConnected).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect({ notice: notice.textContent, action: button.textContent }).toMatchSnapshot()
  await act(async () => { pending.resolve(result) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('dialog')).toBeDefined()
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['delete', 'bulk'] as const)('retains expert %s feedback and confirmation controls throughout a retry', async (action) => {
  const { ctx, slots, getCatalog, deleteCustomExpert, setEnabled } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  const pendingDelete = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['deleteCustomExpert']>>>()
  const pendingBulk = Promise.withResolvers<Awaited<ReturnType<typeof setEnabled>>>()
  const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'Offline', {}) }
  deleteCustomExpert.mockResolvedValueOnce(failure).mockReturnValueOnce(pendingDelete.promise)
  setEnabled.mockResolvedValueOnce(failure).mockReturnValueOnce(pendingBulk.promise)
  const view = render(slots.renderSlot('root', {}))
  onTestFinished(() => { view.unmount(); pendingDelete.resolve(failure); pendingBulk.resolve(failure) })
  fireEvent.click(screen.getByRole('tab', { name: t('custom.source') }))
  const label = t(action === 'delete' ? 'custom.delete' : 'bulk.confirm')
  fireEvent.click(await screen.findByRole('button', { name: t(action === 'delete' ? 'custom.delete' : 'bulk.enable') }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(dialog.getByRole('button', { name: label }))
  const error = await dialog.findByRole('alert')
  const retry = dialog.getByRole<HTMLButtonElement>('button', { name: label })
  await waitFor(() => { expect(retry.disabled).toBe(false) })
  act(() => { retry.click(); retry.click(); fireEvent.keyDown(retry, { key: 'Escape' }) })
  await waitFor(() => { expect(action === 'delete' ? deleteCustomExpert : setEnabled).toHaveBeenCalledTimes(2) })
  expect(retry.isConnected).toBe(true)
  expect(dialog.getByRole('alert')).toBe(error)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(retry.querySelector('[role="status"]')).toBeNull()
  expect({ error: error.textContent, action: retry.textContent, busy: retry.getAttribute('aria-busy') }).toMatchSnapshot()
  if (action === 'delete') {
    getCatalog.mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 9 } })
    await act(async () => { pendingDelete.resolve({ ok: true, value: { experts: [], enabled: [], revision: 9 } }) })
  } else await act(async () => { pendingBulk.resolve({ ok: true, value: { enabled: ['custom-reviewer'], revision: 9 } }) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it.each([
  { name: 'A'.repeat(32) + '🚀' + 'B'.repeat(6), existing: [], expected: 'A'.repeat(32) + '🚀BBB 副本' },
  { name: 'A'.repeat(31) + '👩‍💻', existing: [], expected: 'A'.repeat(31) + '👩‍💻 副本' },
  { name: 'QA', existing: [' qa 副本 ', 'Qa 副本 2'], expected: 'QA 副本 3' },
])('saves the Loader-mounted company expert copy named $expected', async ({ name, existing, expected }) => {
  const { ctx, slots, cache, getCatalog, exportExpert, importExpert, saveCustomExpert } = await fixture(true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  const source = { slug: 'shared-reviewer', name, nameEn: name, description: 'Review code', descriptionEn: 'Review code', division: 'engineering', divisionZh: '工程', emoji: '🧩', custom: false, company: true }
  const catalog = { experts: [source, ...existing.map((name, index) => ({ ...source, name, nameEn: name, slug: `custom-${index}`, custom: true, company: false }))], enabled: [], revision: 8 }
  getCatalog.mockResolvedValue({ ok: true, value: catalog })
  cache.catalog.accept(catalog)
  exportExpert.mockResolvedValue({ ok: true, value: { resourceKey: source.slug, catalog: { name }, files: { 'manifest.json': '{}', 'config/SOUL.md': 'Read the reference' } } })
  importExpert.mockResolvedValue({ ok: true, value: { name, description: 'Review code', division: 'engineering', prompt: 'Read the reference',
    manifest: JSON.stringify({ worker: { suggested_name: 'shared-reviewer' }, description: 'Review code' }), resources: { 'references/中文.txt': 'cmVmZXJlbmNl' } } })
  saveCustomExpert.mockResolvedValue({ ok: true, value: { ...catalog, revision: 9 } })
  render(slots.renderSlot('root', {}))
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: t('settings.search') })
  fireEvent.change(search, { target: { value: name } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('custom.copy') })) })
  const editor = within(await screen.findByRole('dialog', { name: t('custom.new') }))
  const input = editor.getByRole<HTMLInputElement>('textbox', { name: t('custom.name') })
  expect(input.value).toBe(expected)
  await act(async () => { fireEvent.click(editor.getByRole('button', { name: t('custom.save') })) })
  expect(saveCustomExpert).toHaveBeenCalledWith(expect.objectContaining({ name: expected, slug: undefined,
    prompt: 'Read the reference', resources: { 'references/中文.txt': 'cmVmZXJlbmNl' } }), false, catalog.revision, expect.any(AbortSignal))
  expect(source.name).toBe(name)
  expect(screen.getByRole('textbox', { name: t('settings.search') })).toBe(search)
  expect(search.value).toBe('')
  expect(screen.getByRole('tab', { name: t('custom.source') }).getAttribute('aria-selected')).toBe('true')
  expect({ name: input.value, enabled: saveCustomExpert.mock.calls[0]?.[1] }).toMatchSnapshot()
})

it('does not apply a disconnected picker enable receipt or insert it into a reconnected draft', async () => {
  const { ctx, slots, cache, getCatalog, setEnabled, scope, inputFor } = await fixture('picker')
  ctx.locale.setLocale('zh')
  scope.mockReturnValue(ctx)
  const insertReference = vi.fn(() => true)
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '当前需求', draftRev: 1 }) }, insertReference })
  const previous = { experts: [compliance], enabled: [], revision: 8 }
  cache.catalog.accept(previous)
  getCatalog.mockResolvedValue({ ok: true, value: previous })
  const response = Promise.withResolvers<Awaited<ReturnType<Parameters<typeof Experts.writeEnabled>[0]['setEnabled']>>>()
  setEnabled.mockReturnValueOnce(response.promise)
  const view = render(slots.renderSlot('root', {}))
  const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error('Expected expert picker')
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '合规' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /合规审查/ })) })
  expect(setEnabled).toHaveBeenCalledOnce()
  getCatalog.mockResolvedValue({ ok: true, value: { ...previous, revision: 0 } })
  await act(async () => { ctx.emit('connection/reset'); await cache.catalog.refresh() })
  await act(async () => { response.resolve({ ok: true, value: { enabled: [compliance.slug], revision: 9 } }); await response.promise })
  expect(cache.catalog.getSnapshot().revision).toBe(0)
  expect(cache.catalog.getSnapshot().enabled.size).toBe(0)
  expect(insertReference).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  setEnabled.mockResolvedValueOnce({ ok: true, value: { enabled: [compliance.slug], revision: 1 } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /合规审查/ })) })
  expect(setEnabled).toHaveBeenCalledTimes(2)
  expect(insertReference).toHaveBeenCalledOnce()
})

it('keeps a reconnected expert switch usable without reporting its cancelled write as a new failure', async () => {
  const { ctx, slots, cache, getCatalog, setEnabled } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  const previous = cache.catalog.getSnapshot()
  const response = Promise.withResolvers<Awaited<ReturnType<Parameters<typeof Experts.writeEnabled>[0]['setEnabled']>>>()
  setEnabled.mockReturnValueOnce(response.promise)
  fireEvent.click(screen.getByRole('switch'))
  expect(setEnabled).toHaveBeenCalledOnce()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [...previous.experts], enabled: [], revision: 0 } })
  await act(async () => { ctx.emit('connection/reset'); await cache.catalog.refresh() })
  await act(async () => { response.resolve({ ok: true, value: { enabled: ['custom-reviewer'], revision: 9 } }); await response.promise })
  expect(cache.catalog.getSnapshot().revision).toBe(0)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('switch')).toHaveProperty('disabled', false)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it('does not restore a disconnected selection when its failed write recovery crosses Host reset', async () => {
  const { ctx, slots, cache, getCatalog, setEnabled } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  await act(async () => { render(slots.renderSlot('root', {})); await cache.catalog.refresh() })
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  const previous = cache.catalog.getSnapshot()
  const response = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  getCatalog.mockReturnValueOnce(response.promise)
  setEnabled.mockRejectedValueOnce(new Error('Disconnected write'))
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(getCatalog.mock.calls.at(-1)?.[1]?.aborted).toBe(false)
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [...previous.experts], enabled: [], revision: 0 } })
  await act(async () => { ctx.emit('connection/reset'); await cache.catalog.refresh() })
  await act(async () => {
    response.resolve({ ok: true, value: { experts: [...previous.experts], enabled: ['custom-reviewer'], revision: 9 } })
    await response.promise
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(cache.catalog.getSnapshot().revision).toBe(0)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it('preserves the editable expert draft and ignores its save result after Host reset', async () => {
  const { ctx, slots, cache, getCatalog, saveCustomExpert } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: t('custom.edit') }))
  const dialog = within(await screen.findByRole('dialog', { name: t('custom.edit') }))
  fireEvent.change(dialog.getByRole('textbox', { name: t('custom.prompt') }), { target: { value: '保留这份未保存草稿' } })
  const response = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['saveCustomExpert']>>>()
  saveCustomExpert.mockReturnValueOnce(response.promise)
  fireEvent.click(dialog.getByRole('button', { name: t('custom.saveChanges') }))
  const previous = cache.catalog.getSnapshot()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [...previous.experts], enabled: [], revision: 0 } })
  await act(async () => { ctx.emit('connection/reset'); await cache.catalog.refresh() })
  expect(saveCustomExpert.mock.calls[0]?.[3]?.aborted).toBe(true)
  await act(async () => {
    response.resolve({ ok: true, value: { experts: [...previous.experts], enabled: [], revision: 9 } })
    await response.promise
  })
  expect(cache.catalog.getSnapshot().revision).toBe(0)
  expect(dialog.getByRole('textbox', { name: t('custom.prompt') })).toHaveProperty('value', '保留这份未保存草稿')
  expect(dialog.getByRole('button', { name: t('custom.saveChanges') })).toHaveProperty('disabled', false)
  expect(screen.queryByRole('alert')).toBeNull()
  expect({ draft: dialog.getByRole<HTMLTextAreaElement>('textbox', { name: t('custom.prompt') }).value,
    revision: cache.catalog.getSnapshot().revision,
    canSave: !dialog.getByRole<HTMLButtonElement>('button', { name: t('custom.saveChanges') }).disabled }).toMatchSnapshot()
})

it('resolves the composer through the injected conversation service for a separate Session scope', async () => {
  const { slots, scope, inputFor } = await fixture('picker')
  const sessionContext = new Context()
  onTestFinished(() => sessionContext.fiber.dispose())
  scope.mockReturnValue(sessionContext)
  const insertReference = vi.fn(() => true)
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '只读验收', draftRev: 1 }) }, insertReference })
  const inject = slots.entries('conversation.input.left')[0]?.inject as
    ((id: SessionId) => Pick<Parameters<typeof Experts.AgentsButton>[0], 'prepareTeamSelection'>) | undefined
  const injection = inject?.(session.sessionId)
  if (!injection?.prepareTeamSelection) throw new Error('Composer contribution missing')
  await expect(injection.prepareTeamSelection()(TEST_TEAMS[0])).resolves.toBe(true)
  expect(inputFor).toHaveBeenCalledWith(sessionContext)
  expect(insertReference).toHaveBeenCalledWith(expect.objectContaining({ ref: TEST_TEAMS[0].id }), expect.objectContaining({ draftRev: 1 }))
})

it.each([
  { change: 'reset', kind: 'replace' }, { change: 'reset', kind: 'append' },
  { change: 'dispose', kind: 'replace' }, { change: 'dispose', kind: 'append' },
] as const)('cancels a team $kind confirmation on $change without writing to the old composer', async ({ change, kind }) => {
  const { ctx, slots, scope, inputFor, owner } = await fixture('picker')
  ctx.locale.setLocale('zh')
  scope.mockReturnValue(ctx)
  const insertReference = vi.fn(() => true)
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({
    draft: kind === 'replace' ? '\uFFFC 保留原始正文' : '保留原始正文', draftRev: 1,
    occurrences: kind === 'replace' ? [{ source: 'agency-agents:teams', offset: 0, length: 1 }] : [],
  }) }, insertReference })
  const inject = slots.entries('conversation.input.left')[0]?.inject as
    ((id: SessionId) => Pick<Parameters<typeof Experts.AgentsButton>[0], 'prepareTeamSelection'>) | undefined
  const select = inject?.(session.sessionId).prepareTeamSelection?.()
  if (!select) throw new Error('Composer contribution missing')
  let pending!: boolean | Promise<boolean>
  await act(async () => { pending = select(TEST_TEAMS[0], kind === 'append' ? '待追加的示例' : undefined) })
  await screen.findByRole('dialog', { name: '确认选择专家团' })
  await act(async () => {
    if (change === 'reset') ctx.emit('connection/reset')
    else await owner.dispose()
  })
  const remaining = screen.queryByRole('dialog', { name: '确认选择专家团' })
  // Settle an unfixed confirmation so the regression never leaves an extra React root behind.
  if (remaining) await act(async () => { fireEvent.click(within(remaining).getByRole('button', { name: '确认' })) })
  let selected!: boolean
  await act(async () => { selected = await pending })
  expect({ confirmationClosed: remaining === null, selected, insertions: insertReference.mock.calls.length }).toMatchInlineSnapshot(`
    {
      "confirmationClosed": true,
      "insertions": 0,
      "selected": false,
    }
  `)
})

it('rechecks the current composer after confirming a team example', async () => {
  const { ctx, slots, scope, inputFor } = await fixture('picker')
  ctx.locale.setLocale('zh')
  scope.mockReturnValue(ctx)
  const previous = vi.fn(() => true), current = vi.fn(() => true)
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '上一份正文', draftRev: 1 }) }, insertReference: previous })
  const inject = slots.entries('conversation.input.left')[0]?.inject as
    ((id: SessionId) => Pick<Parameters<typeof Experts.AgentsButton>[0], 'prepareTeamSelection'>) | undefined
  const select = inject?.(session.sessionId).prepareTeamSelection?.()
  if (!select) throw new Error('Composer contribution missing')
  let pending!: boolean | Promise<boolean>
  await act(async () => { pending = select(TEST_TEAMS[0], '待追加的示例') })
  const dialog = await screen.findByRole('dialog', { name: '确认选择专家团' })
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '当前正文', draftRev: 1 }) }, insertReference: current })
  let selected!: boolean
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '确认' })); selected = await pending })
  expect(selected).toBe(false)
  expect(previous).not.toHaveBeenCalled()
  expect(current).not.toHaveBeenCalled()
})

it.each(['reset', 'dispose', 'replace'] as const)('completes the confirmed team example in the native composer before %s without a later insertion', async (change) => {
  const { ctx, slots, scope, inputFor, owner } = await fixture('picker')
  ctx.locale.setLocale('zh')
  scope.mockReturnValue(ctx)
  const input = new SessionInputShell({ actx: ctx, defaultSink: vi.fn(), commandAttachments: {
    serialize: async () => [], release: () => {}, unsupportedNotice: () => '',
  } })
  onTestFinished(() => { input.dispose() })
  input.setDraft('@资料 保留原始正文')
  input.insertReference({ source: 'file', ref: 'docs/需求.md', label: '需求.md', clipboardText: '@[需求](docs/需求.md)' },
    { start: 0, end: 3, draftRev: input.snapshot.draftRev })
  input.actions.addAttachments(['attachment-1' as DraftAttachmentId])
  const original = input.snapshot
  inputFor.mockReturnValue(input)
  const insertText = vi.fn(({ text, span }: InsertTextRequest) => input.actions.insertText(text, span) ? true : undefined)
  ctx.on('slash/input-insert-text', insertText)
  const inject = slots.entries('conversation.input.left')[0]?.inject as
    ((id: SessionId) => Pick<Parameters<typeof Experts.AgentsButton>[0], 'prepareTeamSelection'>) | undefined
  const select = inject?.(session.sessionId).prepareTeamSelection?.()
  if (!select) throw new Error('Composer contribution missing')
  let pending!: boolean | Promise<boolean>
  await act(async () => { pending = select(TEST_TEAMS[0], '待追加的示例') })
  const dialog = await screen.findByRole('dialog', { name: '确认选择专家团' })
  vi.useFakeTimers()
  try {
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '确认' })); expect(await pending).toBe(true) })
    expect(insertText).toHaveBeenCalledOnce()
    expect(input.snapshot.draft).toContain('保留原始正文\n\n待追加的示例')
    expect(input.snapshot.occurrences.filter(occurrence => occurrence.source === 'file')).toEqual(original.occurrences)
    expect(input.snapshot.occurrences.filter(occurrence => occurrence.source === 'agency-agents:teams')).toHaveLength(1)
    expect(input.snapshot.attachmentIds).toEqual(original.attachmentIds)
    expect(input.notices.getSnapshot()).toBeNull()
    const selected = input.snapshot
    expect({ draft: selected.draft, references: selected.occurrences.map(({ source, ref }) => ({ source, ref })),
      attachments: selected.attachmentIds }).toMatchInlineSnapshot(`
        {
          "attachments": [
            "attachment-1",
          ],
          "draft": "@[需求](docs/需求.md) @专家团：产品方案评审团  保留原始正文

        待追加的示例",
          "references": [
            {
              "ref": "docs/需求.md",
              "source": "file",
            },
            {
              "ref": "team-custom-00000000-0000-4000-8000-000000000000",
              "source": "agency-agents:teams",
            },
          ],
        }
      `)
    await act(async () => {
      if (change === 'reset') ctx.emit('connection/reset')
      else if (change === 'dispose') await owner.dispose()
      else inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '当前正文', draftRev: 1 }) }, insertReference: vi.fn() })
      await vi.runAllTimersAsync()
    })
    expect(insertText).toHaveBeenCalledOnce()
    expect(input.snapshot).toEqual(selected)
  } finally { vi.useRealTimers() }
})

it('closes the Loader-mounted editor category menu while saving and preserves the draft after failure', async () => {
  const { ctx, slots, saveCustomExpert } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['saveCustomExpert']>>>()
  saveCustomExpert.mockReturnValue(pending.promise)
  try {
    const view = render(slots.renderSlot('root', {}))
    fireEvent.click(within(view.container).getByRole('tab', { name: '我的' }))
    fireEvent.click(within(view.container).getByRole('button', { name: t('custom.edit') }))
    const editor = within(await screen.findByRole('dialog', { name: t('custom.edit') }))
    fireEvent.change(editor.getByRole('textbox', { name: t('custom.name') }), { target: { value: 'Reviewer' } })
    fireEvent.change(editor.getByRole('textbox', { name: t('custom.description') }), { target: { value: 'Review code' } })
    fireEvent.change(editor.getByRole('textbox', { name: t('custom.prompt') }), { target: { value: 'Check changes' } })
    const category = editor.getByRole<HTMLButtonElement>('button', { name: t('custom.division') })
    fireEvent.click(category)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(editor.getByRole('button', { name: t('custom.saveChanges') }))
    expect(saveCustomExpert).toHaveBeenCalledOnce()
    expect(category.disabled).toBe(false)
    expect(category.getAttribute('aria-disabled')).toBe('true')
    expect(category.classList.contains('product-control-pending')).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { pending.reject(new Error('Save unavailable')); await pending.promise.catch(() => {}) })
    expect(editor.getByRole('alert').textContent).toBe('Save unavailable')
    expect(category.disabled).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(editor.getByRole('textbox', { name: t('custom.prompt') })).toHaveProperty('value', 'Check changes')
    expect({ notice: editor.getByRole('alert').textContent, expanded: category.getAttribute('aria-expanded'),
      draft: editor.getByRole<HTMLTextAreaElement>('textbox', { name: t('custom.prompt') }).value }).toMatchInlineSnapshot(`
      {
        "draft": "Check changes",
        "expanded": "false",
        "notice": "Save unavailable",
      }
    `)
  } finally {
    await act(async () => { pending.reject(new Error('Test disposed')); await pending.promise.catch(() => {}) })
  }
})

it('keeps the Loader-mounted team directory retry available until a refresh succeeds', async () => {
  const { ctx, slots, getTeams } = await fixture(true)
  ctx.locale.setLocale('zh')
  getTeams.mockRejectedValue(new Error('Team directory unavailable'))
  const view = render(slots.renderSlot('root', {}))
  fireEvent.click(within(view.container).getByRole('tab', { name: /专家团/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('Team directory unavailable')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新重试' })) })
  expect(screen.getByRole('alert').textContent).toContain('Team directory unavailable')
  expect(screen.getByRole('button', { name: '刷新重试' })).toBeTruthy()
  getTeams.mockResolvedValue({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 9 } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新重试' })) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('审核发布后的专家团会展示在这里。')).toBeTruthy()
  expect({ retryVisible: screen.queryByRole('button', { name: '刷新重试' }) !== null,
    emptyDirectory: screen.getByText('审核发布后的专家团会展示在这里。').textContent }).toMatchInlineSnapshot(`
      {
        "emptyDirectory": "审核发布后的专家团会展示在这里。",
        "retryVisible": false,
      }
    `)
})

it.each(['success', 'failure', 'closed'] as const)('keeps expert picker retry feedback stable until its late %s', async (outcome) => {
  const { ctx, slots, getCatalog } = await fixture('picker')
  ctx.locale.setLocale('zh')
  getCatalog.mockRejectedValue(new Error('Catalog unavailable'))
  const view = render(slots.renderSlot('root', {}))
  const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  fireEvent.click(trigger)
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh['btn.refresh'] })
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  onTestFinished(() => { view.unmount(); pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 9 } }) })
  getCatalog.mockReturnValue(pending.promise)
  const reads = getCatalog.mock.calls.length
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh['btn.refresh'] })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(getCatalog).toHaveBeenCalledTimes(reads + 1)
  expect(screen.queryByText(zh['discovery.working'])).toBeNull()
  expect({ notice: notice.textContent, busy: retry.getAttribute('aria-busy'), focused: document.activeElement === retry }).toMatchInlineSnapshot(`
    {
      "busy": "true",
      "focused": true,
      "notice": "Catalog unavailable",
    }
  `)
  if (outcome === 'closed') fireEvent.click(trigger)
  await act(async () => {
    if (outcome === 'failure') pending.reject(new Error('Still unavailable'))
    else pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 9 } })
  })
  if (outcome === 'closed') expect(screen.queryByRole('dialog')).toBeNull()
  else if (outcome === 'success') expect(screen.queryByRole('alert')).toBeNull()
  else {
    expect(screen.getByRole('alert')).toBe(notice)
    expect(notice.textContent).toContain('Still unavailable')
    expect(retry.getAttribute('aria-disabled')).toBe('false')
    expect(document.activeElement).toBe(retry)
  }
})

it('retains the team directory retry focus and ignores repeat activation while reading', async () => {
  const { ctx, slots, getTeams } = await fixture(true)
  ctx.locale.setLocale('zh')
  getTeams.mockRejectedValue(new Error('Team directory unavailable'))
  const view = render(slots.renderSlot('root', {}))
  fireEvent.click(within(view.container).getByRole('tab', { name: /专家团/ }))
  await screen.findByRole('alert')
  const retry = screen.getByRole('button', { name: '刷新重试' })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof getTeams>>>()
  onTestFinished(() => {
    view.unmount(); pending.resolve({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 9 } })
  })
  getTeams.mockReturnValue(pending.promise)
  const reads = getTeams.mock.calls.length
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  await waitFor(() => { expect(getTeams).toHaveBeenCalledTimes(reads + 1) })
  await act(async () => { pending.reject(new Error('Still unavailable')); await pending.promise.catch(() => undefined) })
  expect(screen.getByRole('button', { name: '刷新重试' })).toBe(retry)
  expect(retry.getAttribute('aria-disabled')).toBe('false')
  expect(document.activeElement).toBe(retry)
})

it('translates a Loader-mounted team directory failure without issuing another read', async () => {
  const { ctx, slots, getTeams } = await fixture(true)
  ctx.locale.setLocale('zh')
  getTeams.mockRejectedValue(new Error('无法读取专家目录，请刷新后重试。'))
  const view = render(slots.renderSlot('root', {}))
  fireEvent.click(within(view.container).getByRole('tab', { name: /专家团/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('无法读取专家目录，请刷新后重试。')
  const reads = getTeams.mock.calls.length
  await act(async () => { ctx.locale.setLocale('en') })
  expect(screen.getByRole('alert').textContent).toContain(teamText('en', '无法读取专家目录，请刷新后重试。'))
  expect(getTeams).toHaveBeenCalledTimes(reads)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  await act(async () => { ctx.locale.setLocale('zh') })
  expect(screen.getByRole('alert').textContent).toContain('无法读取专家目录，请刷新后重试。')
  expect(getTeams).toHaveBeenCalledTimes(reads)
})

it.each([true, false])('translates a failed expert toggle after catalog recovery=%s without repeating the write or read', async (refreshed) => {
  const { ctx, slots, cache, getCatalog, setEnabled } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  await act(async () => { render(slots.renderSlot('root', {})); await cache.catalog.refresh() })
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.change(screen.getByRole('textbox', { name: zh['settings.search'] }), { target: { value: 'Reviewer' } })
  setEnabled.mockRejectedValueOnce(new RemoteError('experts/conflict', 'Private revision diagnostic', {}))
  if (!refreshed) getCatalog.mockRejectedValueOnce(new Error('Private read diagnostic'))
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  const key = refreshed ? 'error.conflict.refreshed' : 'error.conflict.refreshFailed'
  expect(screen.getByRole('alert').textContent).toContain(zh[key])
  const reads = getCatalog.mock.calls.length
  await act(async () => { ctx.locale.setLocale('en') })
  expect(screen.getByRole('alert').textContent).toContain(en[key])
  expect(screen.getByRole('textbox', { name: en['settings.search'] })).toHaveProperty('value', 'Reviewer')
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(setEnabled).toHaveBeenCalledOnce()
  expect(getCatalog).toHaveBeenCalledTimes(reads)
})

it('translates an expert insertion failure without repeating its enable or changing the search', async () => {
  const { ctx, slots, cache, getCatalog, setEnabled, scope, inputFor } = await fixture('picker')
  ctx.locale.setLocale('zh')
  scope.mockReturnValue(ctx)
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '保留需求', draftRev: 1 }) }, insertReference: () => false })
  const catalog = { experts: [compliance], enabled: [], revision: 8 }
  cache.catalog.accept(catalog)
  getCatalog.mockResolvedValue({ ok: true, value: catalog })
  setEnabled.mockResolvedValueOnce({ ok: true, value: { enabled: [compliance.slug], revision: 9 } })
  const view = render(slots.renderSlot('root', {}))
  const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error('Expected expert picker')
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '合规' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /合规审查/ })) })
  expect(screen.getByRole('alert').textContent).toContain(zh['discovery.enabledInsertFailed'])
  const reads = getCatalog.mock.calls.length
  await act(async () => { ctx.locale.setLocale('en') })
  expect(screen.getByRole('alert').textContent).toContain(en['discovery.enabledInsertFailed'])
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '合规')
  expect(getCatalog).toHaveBeenCalledTimes(reads)
  expect(setEnabled).toHaveBeenCalledOnce()
})

it('reports an expert removed during picker refresh in the current language without enabling or inserting it', async () => {
  const { ctx, slots, cache, getCatalog, setEnabled, scope, inputFor } = await fixture('picker')
  ctx.locale.setLocale('zh')
  scope.mockReturnValue(ctx)
  const insertReference = vi.fn(() => true)
  inputFor.mockReturnValue({ state: { getSnapshot: () => ({ draft: '保留需求', draftRev: 1 }) }, insertReference })
  cache.catalog.accept({ experts: [compliance], enabled: [], revision: 8 })
  const request = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  getCatalog.mockReturnValueOnce(request.promise)
  const view = render(slots.renderSlot('root', {}))
  const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error('Expected expert picker')
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '合规' } })
  fireEvent.click(screen.getByRole('button', { name: /合规审查/ }))
  await act(async () => { request.resolve({ ok: true, value: { experts: [], enabled: [], revision: 9 } }) })
  expect(screen.getByRole('alert').textContent).toContain(zh['custom.unavailable'])
  const reads = getCatalog.mock.calls.length
  await act(async () => { ctx.locale.setLocale('en') })
  expect(screen.getByRole('alert').textContent).toContain(en['custom.unavailable'])
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '合规')
  expect(getCatalog).toHaveBeenCalledTimes(reads)
  expect(setEnabled).not.toHaveBeenCalled()
  expect(insertReference).not.toHaveBeenCalled()
})

it('clears disconnected Host data, accepts its new revision and disposes the previous mount', async () => {
  const { ctx, owner, cache, getCatalog, getTeams, unmount, slots } = await fixture()
  const disconnectedCatalog = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  const disconnectedTeams = Promise.withResolvers<Awaited<ReturnType<AgencyTeamsRemote['getTeams']>>>()
  getCatalog.mockReturnValueOnce(disconnectedCatalog.promise)
  getTeams.mockReturnValueOnce(disconnectedTeams.promise)
  ctx.emit('connection/reset')
  expect(cache.catalog.getSnapshot().revision).toBe(-1)
  expect(cache.teams.getSnapshot()).toBeNull()
  disconnectedCatalog.resolve({ ok: true, value: { experts: [], enabled: [], revision: 0 } })
  disconnectedTeams.resolve({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 0 } })
  await vi.waitFor(() => { expect(cache.catalog.getSnapshot().revision).toBe(0); expect(cache.teams.getSnapshot()?.revision).toBe(0) })
  expect(getCatalog).toHaveBeenCalledTimes(2)
  expect(getTeams).toHaveBeenCalledTimes(2)
  await owner.dispose()
  expect(cache.catalog.getSnapshot().revision).toBe(-1)
  expect(cache.teams.getSnapshot()).toBeNull()
  expect(() => cache.catalog.refresh()).toThrow()
  expect(unmount).toHaveBeenCalledTimes(1)
  const nextOwner = ctx.plugin(Experts)
  await nextOwner.await()
  const next = slots.entries('main')[0]?.inject?.().cache
  expect(next).not.toBe(cache)
  await nextOwner.dispose()
  expect(unmount).toHaveBeenCalledTimes(2)
})

const session = { sessionId: SessionId('expert-input') }
const request = { query: '', position: 'inline', drilled: false, signal: new AbortController().signal } as const
const compliance = { slug: 'compliance-review', name: '合规审查', nameEn: 'Compliance review', description: '合规检查',
  descriptionEn: 'Review compliance', emoji: '🔎', division: 'company-compliance', divisionZh: '公司合规', custom: false, company: true }

it.each([false, true])('retains a focused expert card and its avatar when a preceding expert leaves the directory, scrolled: %s', async (scrolled) => {
  const { ctx, cache, getCatalog, slots } = await fixture(true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  const first = { ...compliance, slug: 'first-expert', name: '前一位专家' }
  const others = Array.from({ length: 80 }, (_, index) => ({ ...compliance, slug: `other-${index}`, name: `其他专家 ${index}` }))
  const catalog = { experts: [first, compliance, ...others], enabled: [], revision: 9 }
  getCatalog.mockResolvedValue({ ok: true, value: catalog })
  cache.catalog.accept(catalog)
  const view = render(slots.renderSlot('root', {}))
  const name = await screen.findByText(compliance.name)
  const card = name.closest('article')
  if (!card) throw new Error('Expert card is missing')
  const preview = within(card).getByRole('button', { name: t('settings.viewPromptTitle') })
  const avatar = card.querySelector('img')
  preview.focus()
  if (scrolled) {
    const list = view.container.querySelector<HTMLElement>('.aag-expert-window')
    if (!list) throw new Error('Expert list is missing')
    const bounds = vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -4000, 800, 20000))
    onTestFinished(() => { bounds.mockRestore() })
    fireEvent.scroll(window)
    await waitFor(() => { expect(screen.queryByText(first.name)).toBeNull() })
    expect(document.activeElement).toBe(preview)
  }
  const latest = { ...catalog, experts: [compliance, ...others], revision: 10 }
  getCatalog.mockResolvedValue({ ok: true, value: latest })
  await act(async () => { await cache.catalog.refresh(true) })
  expect(screen.queryByText(first.name)).toBeNull()
  expect(screen.getByText(compliance.name).closest('article')).toBe(card)
  expect(within(card).getByRole('button', { name: t('settings.viewPromptTitle') })).toBe(preview)
  expect(card.querySelector('img')).toBe(avatar)
  expect(document.activeElement).toBe(preview)
  if (scrolled) expect(screen.queryByText(others[0].name)).toBeNull()
  expect({ focusedExpert: document.activeElement?.closest('article')?.textContent,
    cardPreserved: screen.getByText(compliance.name).closest('article') === card,
    avatarPreserved: card.querySelector('img') === avatar,
  }).toMatchSnapshot('Focused expert after directory update')
  view.unmount()
})

it('mounts the picker through the Loader and releases native modal ownership on close and unload', async () => {
  const { slots, cache, owner } = await fixture('picker')
  const view = render(slots.renderSlot('root', {}))
  const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error('Expected expert picker trigger')
  trigger.focus()
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  const dialog = screen.getByRole('dialog')
  expect(dialog.parentElement).toBe(document.body)
  const search = within(dialog).getByRole('searchbox')
  expect(document.activeElement).toBe(search)
  act(() => { closeTopModal(document) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  await act(async () => { await owner.dispose() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true)
})

it('renders confirmed library counters through Loader-mounted native Slot hooks and releases them on unload', async () => {
  const { cache, getCatalog, getTeams, slots, owner } = await fixture(true)
  const catalog = { experts: [compliance], enabled: [compliance.slug], revision: 9 }
  const team = { ...TEST_TEAMS[0], company: true }
  const teams = { teams: [team], enabledTeams: [team.id], enabledExperts: [compliance.slug], revision: 9 }
  getCatalog.mockResolvedValue({ ok: true, value: catalog })
  getTeams.mockResolvedValue({ ok: true, value: teams })
  cache.catalog.accept(catalog); cache.teams.accept(teams)
  const view = render(slots.renderSlot('root', {}))
  const counts = () => [...view.container.querySelectorAll('.aag-tab-count strong')].map(node => node.textContent)
  expect(counts()).toEqual(['1', '1', '1', '1'])
  await act(async () => { await cache.catalog.refresh(); await cache.teams.refresh() })
  act(() => {
    cache.catalog.accept({ ...catalog, enabled: [], revision: 10 })
    cache.teams.accept({ ...teams, enabledTeams: [], revision: 10 })
  })
  expect(counts()).toEqual(['1', '0', '1', '0'])
  act(() => { cache.catalog.reset(); cache.teams.reset() })
  expect(counts()).toEqual(['—', '—', '—', '—'])
  await act(async () => { await owner.dispose() })
  expect(counts()).toEqual([])
})

it('registers newly loaded company categories and removes them when their catalog is replaced', async () => {
  const { ctx, cache, getCatalog, sources, owner } = await fixture()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [compliance], enabled: [compliance.slug], revision: 9 } })
  await cache.catalog.refresh(true)
  const source = sources.get(Experts.inputTriggerSourceId(compliance.division))
  expect(source, 'company category registered after catalog load').toBeDefined()
  if (!source) throw new Error('Company category is missing')
  const candidates = await source.candidates(session, request)
  expect({ candidates: candidates.map(item => item.name), lexicon: source.lexicon?.(session) }).toMatchInlineSnapshot(`
    {
      "candidates": [
        "Compliance review",
      ],
      "lexicon": [
        "Compliance review",
      ],
    }
  `)
  ctx.locale.setLocale('zh')
  expect(sources.get(source.name)?.lexicon?.(session)).toEqual(['合规审查'])
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 10 } })
  await cache.catalog.refresh(true)
  expect(sources.has(source.name)).toBe(false)
  await owner.dispose()
  expect(sources.size).toBe(0)
})

it.each(['moved', 'disabled', 'removed'] as const)('routes an existing expert chip through its native owner after the expert is %s', async (change) => {
  const { ctx, cache, getCatalog, sources } = await fixture()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [compliance], enabled: [compliance.slug], revision: 9 } })
  await cache.catalog.refresh(true)
  const input = ctx.inputTriggers.sessionOf(ctx)
  const reference = Experts.buildExpertReference(compliance, 'en')
  const signal = new AbortController().signal
  await expect(input.serializeReference(reference.source, reference.ref, signal)).resolves.toBe('@Compliance review\u00a0')
  const updated = { ...compliance, division: 'engineering', name: '当前合规专家', nameEn: 'Current compliance expert' }
  getCatalog.mockResolvedValue({ ok: true, value: { experts: change === 'removed' ? [] : [updated],
    enabled: change === 'moved' ? [compliance.slug] : [], revision: 10 } })
  await cache.catalog.refresh(true)
  expect(sources.has(Experts.inputTriggerSourceId(compliance.division))).toBe(false)
  if (change === 'moved') {
    await expect(input.serializeReference(reference.source, reference.ref, signal)).resolves.toBe('@Current compliance expert\u00a0')
  } else {
    await expect(input.serializeReference(reference.source, reference.ref, signal)).rejects.toThrow(ctx.locale.bind('agency')('custom.unavailable'))
  }
})

it('keeps native reference ownership and session warmup independent of menu categories and locale', async () => {
  const { ctx, cache, getCatalog, sources } = await fixture()
  getCatalog.mockClear()
  const input = ctx.inputTriggers.sessionOf(ctx)
  expect(getCatalog).toHaveBeenCalledOnce()
  await cache.catalog.refresh()
  getCatalog.mockClear()
  cache.catalog.accept({ experts: [compliance], enabled: [compliance.slug], revision: 9 })
  ctx.locale.setLocale('zh')
  expect(getCatalog).not.toHaveBeenCalled()
  const reference = Experts.buildExpertReference(compliance, 'zh')
  const owner = sources.get(reference.source)
  expect(owner?.codec).toBeDefined()
  expect(owner?.showGroupTitle).toBe(false)
  await expect(owner?.candidates(session, request)).resolves.toEqual([])
  expect(ctx.inputTriggers.sessionOf(ctx)).toBe(input)
})

it('uses committed catalog notifications for the expert lexicon and releases its subscribers', async () => {
  const { cache, getCatalog, sources, owner } = await fixture()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [{ ...compliance, division: 'engineering' }], enabled: [compliance.slug], revision: 9 } })
  await cache.catalog.refresh()
  const source = sources.get(Experts.inputTriggerSourceId('engineering'))
  if (!source) throw new Error('Engineering source is missing')
  const changed = vi.fn()
  const stop = source.subscribeLexicon?.(session, changed)
  expect(source.lexicon?.(session)).toContain('Compliance review')
  cache.catalog.acceptEnabled({ enabled: [], revision: 10 })
  expect(changed).toHaveBeenCalledOnce()
  expect(source.lexicon?.(session)).toEqual([])
  stop?.()
  cache.catalog.acceptEnabled({ enabled: [compliance.slug], revision: 11 })
  expect(changed).toHaveBeenCalledOnce()
  source.subscribeLexicon?.(session, changed)
  await owner.dispose()
  expect(changed).toHaveBeenCalledOnce()
})

it.each(['disabled', 'removed'] as const)('refuses an old team candidate after the confirmed team snapshot marks it %s', async (state) => {
  const { cache, getTeams, sources } = await fixture()
  const team = TEST_TEAMS[0]
  if (!team) throw new Error('Team fixture is missing')
  const value = { teams: [team], enabledTeams: [team.id], enabledExperts: [], revision: 9 }
  getTeams.mockResolvedValue({ ok: true, value })
  await cache.teams.refresh()
  const source = sources.get('agency-agents:teams')
  if (!source) throw new Error('Team source is missing')
  const [candidate] = await source.candidates(session, request)
  if (!candidate) throw new Error('Team candidate is missing')
  const renamed = { ...team, name: '更新后的专家团' }
  cache.teams.accept({ ...value, teams: [renamed], revision: 10 })
  expect(source.codec?.clipboardText(team.id)).toContain(renamed.name)
  cache.teams.accept({ ...value, teams: state === 'removed' ? [] : value.teams, enabledTeams: [], revision: 11 })
  expect(source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: 0 } })).toBeUndefined()
})

it('creates experts and teams in a native new conversation even without a selected session', async () => {
  const { ctx, slots, startSession } = await fixture(true)
  ctx.locale.setLocale('zh')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('button', { name: '创建专家' }))
  expect(startSession).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ whenDraftExists: 'append' }))
  expect(startSession.mock.lastCall?.[1]?.prompt).toContain('帮我创建一个')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: /专家团/ }))
  fireEvent.click(screen.getByRole('button', { name: '通过对话创建专家团' }))
  expect(startSession).toHaveBeenCalledTimes(2)
  expect(startSession).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ whenDraftExists: 'append' }))
  expect(startSession.mock.lastCall?.[1]?.prompt).toContain('帮我创建一个专家团')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps AI expert creation available throughout an expert toggle', async () => {
  const { ctx, slots, setEnabled, startSession } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  await screen.findByText('Reviewer')
  const response = Promise.withResolvers<Awaited<ReturnType<typeof setEnabled>>>()
  setEnabled.mockReturnValueOnce(response.promise)
  const create = screen.getByRole('button', { name: '创建专家' })
  const changes: MutationRecord[] = []
  const observer = new MutationObserver(records => changes.push(...records))
  observer.observe(create, { attributes: true, childList: true, subtree: true })
  try {
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    expect(create).toHaveProperty('disabled', false)
    fireEvent.click(create)
    expect(startSession).toHaveBeenCalledOnce()
    await act(async () => { response.resolve({ ok: true, value: { enabled: ['old', 'custom-reviewer'], revision: 9 } }); await response.promise })
    expect(screen.getByRole('button', { name: '创建专家' })).toBe(create)
    expect([...changes, ...observer.takeRecords()]).toEqual([])
  } finally {
    observer.disconnect()
    await act(async () => { response.resolve({ ok: true, value: { enabled: ['old', 'custom-reviewer'], revision: 9 } }); await response.promise })
  }
})

it('opens import without empty manual creation fields', async () => {
  const { ctx, slots } = await fixture(true)
  ctx.locale.setLocale('zh')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入专家包' }))
  const dialog = within(screen.getByRole('dialog', { name: '导入专家包' }))
  expect(dialog.getByRole('button', { name: '导入 ZIP' })).toBeTruthy()
  expect(dialog.queryByRole('textbox')).toBeNull()
  expect(dialog.queryByRole('button', { name: '保存并启用' })).toBeNull()
})

it.each(['company', 'custom'] as const)('returns focus to the %s expert search after clearing an empty filter', async (source) => {
  const { ctx, slots } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  const t = ctx.locale.bind('agency')
  render(slots.renderSlot('root', {}))
  if (source === 'custom') fireEvent.click(screen.getByRole('tab', { name: t('custom.source') }))
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: t('settings.search') })
  fireEvent.change(search, { target: { value: 'missing-expert' } })
  const clear = screen.getByRole('button', { name: t('settings.empty.reset') })
  clear.focus()
  fireEvent.click(clear)
  expect(search.value).toBe('')
  expect(document.activeElement).toBe(search)
  expect(screen.queryByRole('button', { name: t('settings.empty.reset') })).toBeNull()
})

it('filters personal experts through the visible category row and preserves the selection', async () => {
  const { ctx, slots } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  render(slots.renderSlot('root', {}))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  expect(await screen.findByText('Reviewer')).toBeTruthy()
  const categories = within(screen.getByRole('navigation', { name: '分类' }))
  const orders = categories.getByRole('button', { name: '订单与售后' })
  fireEvent.click(orders)
  expect(orders.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByText('Reviewer')).toBeNull()
  fireEvent.click(categories.getByRole('button', { name: '全部分类' }))
  expect(screen.getByText('Reviewer')).toBeTruthy()
})

it('keeps market and personal categories fixed while imported category aliases remain discoverable', async () => {
  const { ctx, slots, cache, getCatalog } = await fixture(true, true)
  ctx.locale.setLocale('zh')
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [
    { slug: 'custom-imported', name: 'Imported expert', nameEn: 'Imported expert', description: 'Review code', descriptionEn: '', division: '研发与集成', divisionZh: '研发与集成', emoji: '🧩', custom: true },
    { slug: 'custom-unknown', name: 'Unlisted expert', nameEn: 'Unlisted expert', description: 'Review documents', descriptionEn: '', division: 'shared', divisionZh: 'shared', emoji: '🧩', custom: true },
  ], enabled: [], revision: 9 } })
  await cache.catalog.refresh(true)
  render(slots.renderSlot('root', {}))
  const categoryLabels = ['全部分类', ...CONTENT_CATEGORIES.map(category => category.zh)]
  const categories = within(screen.getByRole('navigation', { name: '分类' }))
  expect(categories.getAllByRole('button').map(button => button.textContent)).toEqual(categoryLabels)
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  expect(categories.getAllByRole('button').map(button => button.textContent)).toEqual(categoryLabels)
  fireEvent.click(categories.getByRole('button', { name: '研发与集成' }))
  expect(screen.getByText('Imported expert')).toBeTruthy()
  expect(screen.queryByText('Unlisted expert')).toBeNull()
  fireEvent.click(categories.getByRole('button', { name: '其他' }))
  expect(screen.getByText('Unlisted expert')).toBeTruthy()
  expect(screen.queryByText('Imported expert')).toBeNull()
  expect(screen.queryByText('shared')).toBeNull()
})

it.each(['reset', 'dispose'] as const)('does not report cancelled expert preloads as failures on %s', async (change) => {
  const { ctx, owner, cache, getCatalog, getTeams } = await fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const catalog = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  const teams = Promise.withResolvers<Awaited<ReturnType<AgencyTeamsRemote['getTeams']>>>()
  getCatalog.mockReturnValueOnce(catalog.promise)
  getTeams.mockReturnValueOnce(teams.promise)
  ctx.emit('connection/reset')
  if (change === 'reset') {
    ctx.emit('connection/reset')
    await cache.catalog.refresh()
    await cache.teams.refresh()
  } else await owner.dispose()
  catalog.resolve({ ok: true, value: { experts: [], enabled: [], revision: 9 } })
  teams.resolve({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 9 } })
  await act(async () => { await Promise.resolve() })
  expect(warn).not.toHaveBeenCalled()
})

it('reports genuine expert preload failures and allows reloading the current connection', async () => {
  const { ctx, cache, getCatalog, getTeams } = await fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const failure = new Error('catalog offline')
  getCatalog.mockRejectedValueOnce(failure)
  getTeams.mockRejectedValueOnce(failure)
  ctx.emit('connection/reset')
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
  expect(warn.mock.calls.every(([, cause]) => cause === failure)).toBe(true)
  ctx.emit('connection/reset')
  await cache.catalog.refresh()
  await cache.teams.refresh()
  expect(cache.catalog.getSnapshot().revision).toBe(8)
  expect(cache.teams.getSnapshot()?.revision).toBe(8)
  expect(warn).toHaveBeenCalledTimes(2)
})
