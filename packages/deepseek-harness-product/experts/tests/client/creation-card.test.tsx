// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react'
import { TEAM_EN } from '../../src/team-i18n.ts'
import { createExpertClientState } from '../../src/client/client-state.ts'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { CreationCard } from '../../src/client/creation-card.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { TeamRemote } from '../../src/client/team-ui.tsx'
import type { CreationEditorData } from '../../src/remote-contract.ts'

let root: Root
let host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve() }); host.remove(); vi.unstubAllGlobals() })
const id = 'ef7b9672-415f-4184-a612-f81611dbd276'
const data: CreationEditorData = { draft: { kind: 'expert', data: { name: 'Review expert', description: 'Review changes', division: 'engineering', emoji: '🧩', avatar: 0, prompt: 'Report findings with evidence.' } }, catalog: { experts: [], enabled: [], revision: 3 }, teams: { teams: [], enabledTeams: [], enabledExperts: [], revision: 3 } }
function fixture(locale: 'zh' | 'en' = 'en') {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected operation'))
  const saveCustomExpert = vi.fn<TeamRemote['saveCustomExpert']>().mockRejectedValue(new Error('Disk full'))
  const remote: TeamRemote = {
    getCatalog: unused, getCustomExpert: unused, saveCustomExpert, deleteCustomExpert: unused, exportTeam: unused,
    getTeams: unused, saveTeam: unused, setTeamEnabled: unused, deleteTeam: unused,
  }
  const loadCreation = vi.fn(() => Promise.resolve(structuredClone(data)))
  const dictionary: Readonly<Record<string, string>> = locale === 'zh' ? zh : en
  const props: React.ComponentProps<typeof CreationCard> = { phase: 'result', block: { kind: 'tool-result', seq: 1, time: 0, callId: 'open', name: 'open_custom_expert_editor', args: PartialArguments.EMPTY, call: null, callTime: null, content: [{ type: 'text', text: 'Draft confirmed' }], isError: false, subCalls: [], meta: { ready: true, proposalId: id } }, remote, cache: createExpertClientState(remote), loadCreation, getActive: () => locale, t: key => dictionary[key] ?? key }
  return { props, loadCreation, saveCustomExpert }
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => { button.click(); await Promise.resolve() })
}
it.each(['zh', 'en'] as const)('opens a prefilled %s editor only on an explicit click and retains the draft on save failure', async (locale) => {
  const { props, loadCreation, saveCustomExpert } = fixture(locale)
  await act(async () => { root.render(<CreationCard {...props} />); await Promise.resolve() })
  expect(loadCreation).not.toHaveBeenCalled()
  const copy = locale === 'zh' ? zh : en
  await click(copy['creation.open'])
  expect(loadCreation).toHaveBeenCalledWith(id)
  expect(document.querySelector<HTMLInputElement>('input[aria-label="' + copy['custom.name'] + '"]')?.value).toBe('Review expert')
  expect([...document.querySelectorAll('textarea')].map(area => area.value)).toContain('Report findings with evidence.')
  expect(saveCustomExpert).not.toHaveBeenCalled()
  expect({ action: host.querySelector('button')?.textContent, fields: [...document.querySelectorAll('input,textarea')].filter((field): field is HTMLInputElement | HTMLTextAreaElement => field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement).map(field => ({ label: field.getAttribute('aria-label'), value: field.value })) }).toMatchSnapshot()
  await click(copy['custom.save'])
  expect(document.body.textContent).toContain('Disk full')
  expect([...document.querySelectorAll('textarea')].some(area => area.value === 'Report findings with evidence.')).toBe(true)
  expect(saveCustomExpert).toHaveBeenCalledTimes(1)
  saveCustomExpert.mockResolvedValueOnce({ ok: true, value: { ...data.catalog, revision: 4 } })
  await click(copy['custom.save'])
  expect(document.querySelector('form')).toBeNull()
  expect(saveCustomExpert).toHaveBeenCalledTimes(2)
})
it('shows an expired or claimed draft error without opening an empty editor', async () => {
  const { props, loadCreation } = fixture()
  loadCreation.mockRejectedValueOnce(new Error('Draft expired or opened elsewhere'))
  await act(async () => { root.render(<CreationCard {...props} />); await Promise.resolve() })
  await click(en['creation.open'])
  expect(document.body.textContent).toContain('Draft expired or opened elsewhere')
  expect(document.querySelector('form')).toBeNull()
})

it('confirms the visible bulk count, cancels without writing, and preserves another window’s selection', async () => {
  const { AgencySettingsPanel } = await import('../../src/client/index.ts')
  const emptyTeams = { teams: [], enabledTeams: [], enabledExperts: [], revision: 3 }
  const makeExpert = (slug: string, company: boolean) => ({ slug, name: slug, nameEn: slug, description: slug, descriptionEn: '', division: 'engineering', divisionZh: '研发', emoji: '🧩', custom: !company, company })
  let catalog = { experts: [makeExpert('target', true), makeExpert('other', false)], enabled: [] as string[], revision: 3 }
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected operation'))
  const setEnabled = vi.fn((enabled: string[], revision: number) => {
    if (revision !== catalog.revision) throw new Error('Revision conflict')
    catalog = { ...catalog, enabled, revision: revision + 1 }
    return Promise.resolve({ ok: true as const, value: { enabled, revision: catalog.revision } })
  })
  const remote: React.ComponentProps<typeof AgencySettingsPanel>['remote'] = {
    getCatalog: () => Promise.resolve({ ok: true, value: structuredClone(catalog) }),
    getTeams: () => Promise.resolve({ ok: true, value: emptyTeams }),
    getEnabled: () => Promise.resolve({ ok: true, value: { enabled: catalog.enabled, revision: catalog.revision } }),
    setEnabled, getPrompt: unused, getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused,
  }
  const dictionary: Readonly<Record<string, string>> = en
  const props: React.ComponentProps<typeof AgencySettingsPanel> = { remote, cache: createExpertClientState(remote), getActive: () => 'en', prepareTeamSelection: () => () => false,
    t: (key, values) => (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => {
      const value = values?.[name]
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      throw new Error(`Unsupported translation value: ${name}`)
    }),
  }
  await act(async () => { root.render(<AgencySettingsPanel {...props} />); await Promise.resolve() })
  await click(en['bulk.enable'])
  expect(document.body.textContent).toContain('Enable 1 experts in this list.')
  await click(en['bulk.cancel'])
  expect(setEnabled).not.toHaveBeenCalled()
  await click(en['bulk.enable'])
  catalog = { ...catalog, enabled: ['other'], revision: 6 }
  await click(en['bulk.confirm'])
  expect(setEnabled).toHaveBeenCalledWith(['other', 'target'], 6)
  expect(document.body.textContent).not.toContain(en['bulk.title'])
})

it('keeps the existing member-enable confirmation and refreshes expert activation after saving a team', async () => {
  const { props, loadCreation } = fixture()
  const members = ['one', 'two'].map(expertSlug => ({ expertSlug, duty: expertSlug, instructions: 'Review the assigned material' }))
  const experts = members.map(member => ({ slug: member.expertSlug, name: member.expertSlug, nameEn: member.expertSlug, description: 'Review changes', descriptionEn: '', division: 'engineering', divisionZh: '研发', emoji: '🧩', custom: false }))
  const team = { name: 'Review team', description: 'Review changes together', tags: ['review'], goal: 'Find actionable defects', constraints: '', deliveryRequirements: 'Findings with evidence', members, examples: ['Review this change'], coordinatorMode: 'template' as const, coordinatorTemplateId: 'technical' as const, coordinatorTemplateVersion: 1 as const, coordinatorPrompt: '' }
  const teamId = 'team-custom-' + id
  loadCreation.mockResolvedValueOnce({ draft: { kind: 'team', data: team }, catalog: { experts, enabled: [], revision: 3 }, teams: data.teams })
  const saveTeam = vi.fn<TeamRemote['saveTeam']>().mockResolvedValue({ ok: true, value: { teams: [{ ...team, id: teamId }], enabledTeams: [teamId], enabledExperts: ['one', 'two'], revision: 4 } })
  props.remote.saveTeam = saveTeam
  await act(async () => { root.render(<CreationCard {...props} />); await Promise.resolve() })
  await click(en['creation.open'])
  await click(TEAM_EN['保存并启用'])
  expect(saveTeam).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(TEAM_EN['启用团队成员'])
  await click(TEAM_EN['启用团队及所需成员'])
  expect(saveTeam).toHaveBeenCalledWith(team, true, 3)
  expect([...props.cache.catalog.getSnapshot().enabled]).toEqual(['one', 'two'])
  expect(document.querySelector('form')).toBeNull()
})

it.each(['expert', 'team'] as const)('keeps an unsaved %s form mounted while a reconnected Host reloads its catalog', async (kind) => {
  const { AgencySettingsPanel } = await import('../../src/client/index.ts')
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const remote: React.ComponentProps<typeof AgencySettingsPanel>['remote'] = {
    getCatalog: async () => ({ ok: true, value: { experts: [], enabled: [], revision: 3 } }),
    getTeams: async () => ({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 3 } }),
    getEnabled: unused, setEnabled: unused, getPrompt: unused, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused,
  }
  const cache = createExpertClientState(remote)
  const dictionary: Readonly<Record<string, string>> = en
  await act(async () => {
    root.render(<AgencySettingsPanel remote={remote} cache={cache} getActive={() => 'en'}
      prepareTeamSelection={() => () => false} t={key => dictionary[key] ?? key} />)
  })
  await click(en['custom.source'])
  if (kind === 'team') {
    const tab = document.getElementById('aag-library-tab-teams')
    if (!tab) throw new Error('Team tab missing')
    await act(async () => { tab.click() })
  }
  await click(kind === 'expert' ? en['custom.new'] : TEAM_EN['新建专家团'])
  const prompt = document.querySelector<HTMLTextAreaElement>('textarea')
  if (!prompt) throw new Error('Expert prompt editor missing')
  await act(async () => { fireEvent.change(prompt, { target: { value: 'Unsaved instructions' } }) })
  await act(async () => { cache.catalog.reset(); cache.teams.reset() })
  expect(document.querySelector('textarea')).toBe(prompt)
  expect(prompt.value).toBe('Unsaved instructions')
  await act(async () => { await cache.catalog.refresh(); await cache.teams.refresh() })
  expect(document.querySelector('textarea')).toBe(prompt)
  expect(prompt.value).toBe('Unsaved instructions')
})
