import { expect, it, vi } from 'vitest'
import { loadCatalogPackage, readCatalogSkill } from '../src/catalog-skill.ts'
import { searchSkillsSh } from '../src/skills-sh-catalog.ts'

const target = { catalog: 'skillsh', source: 'instudio/skills', skillId: 'audit-orders' }
const markdown = '---\nname: audit-orders\ndescription: 审核订单\n---\n  保留正文和空白。\n'
const file = { path: 'SKILL.md', contents: markdown }

it('reads details and packages from the same validated files without changing UTF-8 content', async () => {
  const files = [file, { path: 'references/orders.md', contents: '订单\r\n' }]
  const fetchImpl = vi.fn(async () => Response.json({ files }))
  expect(await readCatalogSkill(target, fetchImpl)).toEqual({
    name: 'audit-orders', description: '审核订单', body: '  保留正文和空白。\n', origin: 'instudio/skills/audit-orders',
  })
  expect(await loadCatalogPackage(target, fetchImpl)).toEqual({
    name: 'audit-orders', entries: files.map(entry => ({ path: entry.path, data: Buffer.from(entry.contents).toString('base64') })),
  })
})

it.each([
  null, [], { files: [] }, { files: Array.from({ length: 101 }, () => file) },
  { files: [null] }, { files: [{ path: 'SKILL.md', contents: 1 }] },
  { files: [{ path: 1, contents: markdown }] },
])('rejects malformed or unbounded catalog files: %j', async (payload) => {
  const fetchImpl = vi.fn(async () => Response.json(payload))
  await expect(readCatalogSkill(target, fetchImpl)).rejects.toMatchObject({ code: 'error.catalog.response', statusCode: 502 })
  await expect(loadCatalogPackage(target, fetchImpl)).rejects.toMatchObject({ code: 'error.catalog.response', statusCode: 502 })
})

it.each([
  [{ path: 'references/orders.md', contents: markdown }],
  [file, { path: '../orders.md', contents: 'invalid' }],
])('rejects packages missing the skill document or containing traversal paths: %j', async (files) => {
  await expect(loadCatalogPackage(target, vi.fn(async () => Response.json({ files })))).rejects.toMatchObject({ code: 'error.catalog.response', statusCode: 502 })
})

it('filters untrusted search entries and returns validated, deduplicated fields', async () => {
  const entry = { id: 'instudio/skills/audit-orders', source: 'instudio/skills', skillId: 'audit-orders', name: ' 审核订单 ', installs: 2, ignored: 'external' }
  const fetchImpl = vi.fn(async () => Response.json({ skills: [null, [], 'invalid', {}, { ...entry, source: '../skills' }, entry, entry] }))
  expect(await searchSkillsSh('audit', fetchImpl)).toEqual({
    skills: [{ id: entry.id, source: entry.source, skillId: entry.skillId, name: '审核订单', installs: 2 }],
  })
})

it.each([null, [], { skills: {} }])('rejects search responses without a skills array: %j', async (payload) => {
  await expect(searchSkillsSh('audit', vi.fn(async () => Response.json(payload)))).rejects.toMatchObject({ code: 'error.catalog.response', statusCode: 502 })
})
