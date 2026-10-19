import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createInstalledSkills } from '../src/installed-skills.ts'
import type { SkillContent } from '../src/content.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename), writeFile: vi.fn(original.writeFile) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'installed-skills-uninstall-'))
  let employee = 'employee-one'
  const ctx = new Context()
  const releases = [() => ctx.fiber.dispose()]
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const projections: Pick<Context['sessionProjections'], 'register'> = { register: vi.fn() }
  const agents: Pick<Context['agents'], 'list' | 'get'> = { list: () => [], get: () => undefined }
  ctx.provide('sessionProjections', projections as Context['sessionProjections'])
  ctx.provide('agents', agents as Context['agents'])
  const skill = (id: string): SkillContent => ({ id, name: id, version: '1', sha256: 'a'.repeat(64),
    summary: 'Review facts.', connectorRefs: [], knowledgeBaseRefs: [], requiredTools: [] })
  const invoke = vi.fn(async (method: string, payload?: unknown) => method === 'auth.getSession'
    ? { authenticated: true, employeeId: employee } : skill((payload as { id: string }).id))
  const install = vi.fn(async (_skill: SkillContent) => {})
  const load = vi.fn(async (entry: SkillContent) => ({ name: entry.id, description: entry.summary, provider: 'fixture',
    source: 'user' as const, invocation: { modelInvocable: true, userInvocable: true }, content: 'Review facts.' }))
  const skills = createInstalledSkills(ctx, {
    root, product: { invoke }, parse: value => value as SkillContent[], install, load,
    capabilities: async () => ({ connectorIds: [], requiredConnectorIds: [], knowledgeBaseIds: [],
      requiredKnowledgeBaseIds: [], knowledgeBaseRefs: [] }), connectors: async () => [], mountConnectors: async () => async () => {},
  })
  return { root, skills, install, load, invoke, releases, employee: (value: string) => { employee = value },
    path: (id = 'employee-one') => join(root, `installed-${createHash('sha256').update(id).digest('hex')}.json`) }
}

it('removes only the authenticated employee installation without loading or deleting content', async () => {
  const f = await fixture()
  await f.skills.install('review-skill')
  await f.skills.install('report-skill')
  const before = await f.skills.read()
  f.employee('employee-two')
  await f.skills.uninstall('review-skill')
  expect((await f.skills.read()).installed).toEqual([])
  f.employee('employee-one')
  expect(await f.skills.read()).toEqual(before)
  expect(await f.skills.uninstall('review-skill')).toEqual({ id: 'review-skill' })
  expect((await f.skills.read()).installed.map(entry => entry.id)).toEqual(['report-skill'])
  expect(f.install).toHaveBeenCalledTimes(2)
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.invoke.mock.calls.filter(([method]) => method === 'skills.get')).toHaveLength(2)
})

it('serializes install and uninstall and rejects queued cancellation without removing another installation', async () => {
  const f = await fixture()
  let release!: () => void
  f.install.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
  const first = f.skills.install('review-skill')
  await vi.waitFor(() => { expect(f.install).toHaveBeenCalledOnce() })
  const remove = f.skills.uninstall('review-skill')
  const second = f.skills.install('report-skill')
  const controller = new AbortController()
  const cancelled = expect(f.skills.uninstall('report-skill', controller.signal)).rejects.toThrow('Queued removal cancelled')
  controller.abort(new Error('Queued removal cancelled'))
  release()
  await first
  await remove
  await second
  await cancelled
  expect((await f.skills.read()).installed.map(entry => entry.id)).toEqual(['report-skill'])
})

it('retains committed membership after persistence failure or cancellation during the temporary write', async () => {
  const f = await fixture()
  await f.skills.install('review-skill')
  const original = await readFile(f.path(), 'utf8')
  vi.mocked(rename).mockRejectedValueOnce(new Error('Disk write failed'))
  await expect(f.skills.uninstall('review-skill')).rejects.toThrow('Disk write failed')
  expect(await readFile(f.path(), 'utf8')).toBe(original)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const controller = new AbortController()
  vi.mocked(writeFile).mockImplementationOnce(async (file, data, options) => {
    await actual.writeFile(file, data, options)
    controller.abort(new Error('Cancel temporary write'))
  })
  await expect(f.skills.uninstall('review-skill', controller.signal)).rejects.toThrow('Cancel temporary write')
  expect(await readFile(f.path(), 'utf8')).toBe(original)
  expect((await f.skills.read()).installed.map(entry => entry.id)).toEqual(['review-skill'])
  expect((await readdir(f.root)).filter(file => file.endsWith('.tmp'))).toEqual([])
})

it('rejects identity changes during removal and refuses requests after release', async () => {
  const f = await fixture()
  await f.skills.install('review-skill')
  const original = await readFile(f.path(), 'utf8')
  f.invoke.mockResolvedValueOnce({ authenticated: true, employeeId: 'employee-one' })
  f.invoke.mockResolvedValueOnce({ authenticated: true, employeeId: 'employee-two' })
  await expect(f.skills.uninstall('review-skill')).rejects.toThrow('Employee changed during skill removal')
  expect(await readFile(f.path(), 'utf8')).toBe(original)
  await f.releases[0]?.()
  await expect(f.skills.uninstall('review-skill')).rejects.toThrow('disposed')
  expect(await readFile(f.path(), 'utf8')).toBe(original)
})
