// @vitest-environment jsdom
/** The mounted expert plugin owns and resets the same data used by its UI contributions. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { InputTriggerService, type InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
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

afterEach(cleanup)

async function fixture(renderMain: boolean | 'picker' = false, personal = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('locale', new LocaleRuntime(ctx))
  const binding = { session, sessionId: session.sessionId, ctx }
  ctx.provide('sessions', { scope: () => undefined,
    sessionOf: (scope: Context) => scope === ctx ? session : undefined,
    binding: (id: ReturnType<typeof SessionId>) => id === session.sessionId ? binding : undefined,
  } as never)
  ctx.provide('conversation', {} as never)
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
  ctx.provide('remote.agencyAgents', { getCatalog, getTeams, saveCustomExpert, getCustomExpert: async () => ({ ok: true, value: { slug: 'custom-reviewer', name: 'Reviewer', description: 'Review code', division: 'engineering', prompt: 'Check changes' } }) } as never)
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
  return { ctx, owner, cache, getCatalog, getTeams, saveCustomExpert, unmount, slots, sources, startSession }
}

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
    expect(category.disabled).toBe(true)
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

it('mounts the picker through the Loader and releases native modal ownership on close and unload', async () => {
  const { slots, cache, owner } = await fixture('picker')
  const view = render(slots.renderSlot('root', {}))
  const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error('Expected expert picker trigger')
  trigger.focus()
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  const search = within(view.container).getByRole('searchbox')
  expect(document.activeElement).toBe(search)
  act(() => { closeTopModal(document) })
  expect(within(view.container).queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  expect(within(view.container).queryByRole('dialog')).not.toBeNull()
  await act(async () => { await owner.dispose() })
  expect(view.container.querySelector('[role="dialog"]')).toBeNull()
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
