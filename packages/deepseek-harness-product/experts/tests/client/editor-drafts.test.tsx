// @vitest-environment jsdom
/** Personal editor drafts use the saved contents through the native Host and Remote. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { AGENCY_LIBRARY_SERVICE, agencySettingsSchema, createExpertLibrary, type AgencySettings } from '../../src/expert-library.ts'
import { AGENCY_TEAM_SERVICE, createTeamLibrary } from '../../src/team-library.ts'
import { MemorySettings } from '../../src/settings-memory.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import { TYPERT_REMOTE } from '../../src/remote-contract.ts'
import Remote from '../../src/remote.ts'
import { TeamEditor } from '../../src/client/team-editor.tsx'
import { CustomExpertEditor } from '../../src/client/custom-editor.ts'
import type { AgencyCatalogRemote } from '../../src/client/remote.ts'
import { zh } from '../../src/client/locales.ts'
import { testPackageStore } from '../packages.ts'

afterEach(cleanup)

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'team-conflict-review-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const settings = new MemorySettings()
  settings.register('agency-agents', agencySettingsSchema)
  const store = {
    read: () => settings.get('agency-agents') as AgencySettings,
    revision: () => settings.describe().find(value => value.ns === 'agency-agents')!.revision,
    mutate: (ops, revision) => settings.mutate('agency-agents', ops, revision),
  } satisfies Parameters<typeof createExpertLibrary>[1]
  const library = createExpertLibrary(async () => [], store, ['engineering'], () => 'zh', testPackageStore())
  const teams = createTeamLibrary(async (_session, signal) => ({ all: await library.catalog(signal), shared: [] }), store, () => 'zh')
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, typert: Typert, gateway: Gateway, access: Access, remote: Remote,
    library: { apply(scope: Context) {
      scope.reflect.provide('settings', settings)
      scope.reflect.provide(AGENCY_LIBRARY_SERVICE, library)
      scope.reflect.provide(AGENCY_TEAM_SERVICE, teams)
    } } })
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['library', 'typert', 'access', 'gateway', 'remote'].map(name => `- name: 'cordis:${name}'`).join('\n') + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown>) =>
    ctx.typertGateway.invoke({ namespace: 'agencyAgents', method, args, peer })
  return { invoke, teams, settings }
}

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

it.each([
  { field: 'description', choice: '保留我的草稿', local: 'original', dirty: true },
  { field: 'description', choice: '保留我的草稿', local: 'latest', dirty: false },
  { field: 'description', choice: '保留我的草稿', local: 'different', dirty: true },
  { field: 'description', choice: '使用最新内容', local: 'different', dirty: false },
  { field: 'tags', choice: '保留我的草稿', local: 'latest', dirty: false },
  { field: 'tags', choice: '保留我的草稿', local: 'different', dirty: true },
] as const)('compares $local $field edits with the reviewed team after $choice', async ({ field, choice, local, dirty }) => {
  const { invoke, teams, settings } = await boot()
  for (const name of ['Reviewer', 'Architect']) {
    await invoke('saveCustomExpert', { expert: { name, description: 'Review changes', division: 'engineering', prompt: 'Read the evidence.' },
      enabled: false, expectedRevision: settings.describe()[0].revision })
  }
  const catalog = TYPERT_REMOTE.methods['agencyAgents/getCatalog'].result.create().parse(await invoke('getCatalog', { refreshCompany: false }))
  const { id: _id, ...template } = TEST_TEAMS[0]
  const saved = TYPERT_REMOTE.methods['agencyAgents/saveTeam'].result.create().parse(await invoke('saveTeam', {
    team: { ...template, members: catalog.experts.map(expert => ({ expertSlug: expert.slug, duty: 'Review', instructions: 'Report findings' })) },
    enabled: false, expectedRevision: catalog.revision,
  }))
  const initial = saved.teams[0]
  const latest = field === 'tags' ? { ...initial, tags: ['最新标签'] } : { ...initial, description: '另一窗口更新的简介' }
  await invoke('saveTeam', { team: latest, enabled: false, expectedRevision: saved.revision })
  const committed = structuredClone(settings.disk)
  const close = vi.fn()
  const refresh = vi.fn(async () => TYPERT_REMOTE.methods['agencyAgents/getTeams'].result.create().parse(await invoke('getTeams', {})))
  const save = vi.fn<Parameters<typeof TeamEditor>[0]['save']>(async (team, enabled, revision) => {
    await invoke('saveTeam', { team, enabled, expectedRevision: revision ?? saved.revision })
  })
  await act(async () => { render(<TeamEditor initial={initial} experts={catalog.experts} enabled={false} enabledExperts={[]}
    save={save} refresh={refresh} close={close} />) })
  if (local !== 'original') fireEvent.change(screen.getByRole('textbox', { name: field === 'tags' ? '场景标签' : '一句话简介' }), {
    target: { value: field === 'tags' ? local === 'latest' ? '最新标签' : '尚未保存的标签'
      : local === 'latest' ? latest.description : '尚未保存的另一份简介' },
  })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存修改' })) })
  expect(screen.getByRole('alert').textContent).toBe('配置已更新，请读取最新内容后重试。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取最新配置' })) })
  fireEvent.click(screen.getByRole('button', { name: choice }))
  expect(settings.disk).toEqual(committed)
  expect(refresh).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledOnce()
  expect(unloadPrevented()).toBe(dirty)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(close).toHaveBeenCalledTimes(dirty ? 0 : 1)
  const dialogs = screen.getAllByRole('dialog')
  expect(dialogs).toHaveLength(dirty ? 2 : 1)
  expect({ choice, local, reloadProtected: unloadPrevented(), closeRequested: close.mock.calls.length,
    description: screen.getByRole<HTMLTextAreaElement>('textbox', { name: '一句话简介', hidden: true }).value,
    tags: screen.getByRole<HTMLInputElement>('textbox', { name: '场景标签', hidden: true }).value,
    confirmation: dirty ? within(dialogs[1]).getByRole('heading').textContent : null }).toMatchSnapshot()
  expect((await teams.snapshot()).teams[0]).toEqual(latest)
  if (dirty) {
    fireEvent.keyDown(dialogs[1], { key: 'Escape' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存修改' })) })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][2]).toBe(saved.revision + 1)
    const accepted = (await teams.snapshot()).teams[0]
    expect(accepted[field]).toEqual(field === 'tags' ? ['尚未保存的标签']
      : local === 'original' ? initial.description : '尚未保存的另一份简介')
    expect(screen.queryByRole('alert')).toBeNull()
  }
})

it.each(['same', 'changed'] as const)('protects the expert only when restoring an attachment with %s bytes', async (content) => {
  const { invoke, settings } = await boot()
  const first = 'assets/先模板.bin', second = 'assets/后模板.bin'
  const saved = TYPERT_REMOTE.methods['agencyAgents/saveCustomExpert'].result.create().parse(await invoke('saveCustomExpert', {
    expert: { name: '评审专家', description: '检查内容', division: 'engineering', prompt: '保留说明 {{literal}}',
      resources: { [first]: 'AAH/', [second]: 'AgM=' } },
    enabled: false, expectedRevision: 0,
  }))
  const expert = TYPERT_REMOTE.methods['agencyAgents/getCustomExpert'].result.create().parse(await invoke('getCustomExpert', { slug: saved.experts[0].slug }))
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected Remote operation'))
  const remote: AgencyCatalogRemote = { getCatalog: unused, importExpert: unused, exportExpert: unused, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused }
  const close = vi.fn()
  const committed = structuredClone(settings.disk)
  const dictionary: Readonly<Record<string, string>> = zh
  render(<CustomExpertEditor expert={expert} enabled={false} revision={saved.revision} divisions={['engineering']}
    locale="zh" t={key => dictionary[key] ?? key} remote={remote} prepareSave={() => vi.fn()} onClose={close} />)
  expect(unloadPrevented()).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: `${zh['custom.removeAttachment']}: ${first}` }))
  expect(unloadPrevented()).toBe(true)
  const bytes = new Uint8Array(content === 'same' ? [0, 1, 255] : [0, 1, 254])
  const file = new File([bytes], '先模板.bin')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  await act(async () => { fireEvent.change(screen.getByLabelText(zh['custom.attachments']), { target: { files: [file] } }) })
  expect(screen.getByText(first)).toBeTruthy()
  expect(screen.getByText(second)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(unloadPrevented()).toBe(content === 'changed')
  fireEvent.click(screen.getByRole('button', { name: zh['custom.cancel'] }))
  expect(close).toHaveBeenCalledTimes(content === 'same' ? 1 : 0)
  expect({ content, reloadProtected: unloadPrevented(), closeRequested: close.mock.calls.length,
    dialogs: screen.getAllByRole('dialog').length }).toMatchSnapshot()
  expect(settings.disk).toEqual(committed)
})
