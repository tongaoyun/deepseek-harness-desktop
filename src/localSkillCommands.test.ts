import { beforeEach, expect, it, vi } from 'vitest'
import { createSkillDownload } from './api'
import { installExtension } from './expertKits'
import { inspectGithubSkills, installGithubSkill } from './githubSkills'
import { localSkillCommand, type SkillCommandContext } from './localSkillCommands'
import type { SkillView } from './skills'

vi.mock('./api', () => ({ createSkillDownload: vi.fn() }))
vi.mock('./expertKits', () => ({ installExtension: vi.fn() }))
vi.mock('./githubSkills', () => ({ inspectGithubSkills: vi.fn(), installGithubSkill: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
const skill = { id: 'report', name: '销售报告', summary: '分析订单', version: '1.0.0', sha256: 'a'.repeat(64), installState: 'available', triggers: ['统计'], connectorIssues: [], knowledgeIssues: [] } as unknown as SkillView
const context = (): SkillCommandContext => ({ skills: [skill], endpoint: '/skills', employeeId: 'employee', sessionToken: 'test', assertActive: vi.fn(), refresh: vi.fn(async () => {}) })

it('searches real localized metadata and returns installation and dependency state', async () => {
  expect(await localSkillCommand(context(), 'search', { query: '统计' })).toMatchObject({ total: 1, skills: [{ id: 'report', name: '销售报告', enabled: false, installState: 'available' }] })
  expect(await localSkillCommand(context(), 'search', { query: 'nonexistent' })).toEqual({ total: 0, skills: [] })
})
it('refuses a changed catalog receipt and a session change before installation', async () => {
  vi.mocked(createSkillDownload).mockResolvedValue({ id: skill.id, version: '2.0.0', sha256: skill.sha256, url: 'https://example.com/report.zip', expiresAt: '2099-01-01T00:00:00Z' })
  await expect(localSkillCommand(context(), 'install', { id: skill.id })).rejects.toThrow('目录已变化')
  const state = context()
  vi.mocked(state.assertActive).mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('账号已切换') })
  await expect(localSkillCommand(state, 'install', { id: skill.id })).rejects.toThrow('账号已切换')
  expect(installExtension).not.toHaveBeenCalled()
})
it('installs an inspected GitHub root skill and reports next-turn availability', async () => {
  vi.mocked(installGithubSkill).mockResolvedValue({ manifest: { id: 'root-skill', name: '根技能', version: '1.0.0' } } as Awaited<ReturnType<typeof installGithubSkill>>)
  const state = context()
  expect(await localSkillCommand(state, 'install', { archiveId: 'b'.repeat(64), path: '' })).toMatchObject({ id: 'root-skill', availableFrom: 'next-turn' })
  expect(installGithubSkill).toHaveBeenCalledWith('b'.repeat(64), '')
  expect(state.refresh).toHaveBeenCalledOnce()
  await expect(localSkillCommand(state, 'install', { id: 'report', archiveId: 'b'.repeat(64), path: '' })).rejects.toThrow('一种安装来源')
})
it('propagates inspection failure without installing', async () => {
  vi.mocked(inspectGithubSkills).mockRejectedValue(new Error('网络不可用'))
  await expect(localSkillCommand(context(), 'inspect_github', { sourceUrl: 'https://github.com/team/repo' })).rejects.toThrow('网络不可用')
  expect(installGithubSkill).not.toHaveBeenCalled()
})
