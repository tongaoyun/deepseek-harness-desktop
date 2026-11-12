/** Corrupt durable trash records must never overwrite another skill or consume recovery files. */
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deleteSkill, listTrash, restoreTrash, trashRootPath, userRoots } from '../src/core.ts'

vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => process.env.DSH_HOME! }))
let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'harness-trash-recovery-')))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_CODEX_HOME', join(home, '.codex'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

async function fixture() {
  const root = userRoots().find(root => root.key === 'dsh')!
  await mkdir(join(root.path, 'audit-orders'), { recursive: true })
  await writeFile(join(root.path, 'audit-orders/SKILL.md'), '---\nname: audit-orders\ndescription: Review orders\n---\nKeep the evidence.')
  await writeFile(join(root.path, 'audit-orders.md'), 'Flat skill evidence')
  const receipt = await deleteSkill(root, 'audit-orders')
  if (!('id' in receipt) || !receipt.id) throw new Error('Trash failed')
  const path = join(trashRootPath(), receipt.id), file = join(path, 'metadata.json')
  const metadata: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Trash metadata unavailable')
  return { root, id: receipt.id, path, file, metadata }
}

it('rejects a trash filename for another skill before overwriting its existing file', async () => {
  const item = await fixture()
  await writeFile(join(item.root.path, 'other.md'), 'Keep the installed skill')
  await writeFile(join(item.path, 'other.md'), 'Untrusted replacement')
  await writeFile(item.file, JSON.stringify({ ...item.metadata, entries: ['other.md'] }))
  await expect(restoreTrash(item.id)).rejects.toMatchObject({ code: 'error.trash.invalid' })
  expect(await readFile(join(item.root.path, 'other.md'), 'utf8')).toBe('Keep the installed skill')
  expect(await readFile(join(item.path, 'other.md'), 'utf8')).toBe('Untrusted replacement')
  expect(await readFile(join(item.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
})

it.each([[], ['audit-orders', 'audit-orders'], ['audit-orders', 1], ['../other.md']].map(entries => ({ entries })))('does not consume a malformed trash entry $entries', async ({ entries }) => {
  const item = await fixture()
  await writeFile(item.file, JSON.stringify({ ...item.metadata, entries }))
  expect(await listTrash()).toEqual([])
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(item.path), expect.any(Error))
  await expect(restoreTrash(item.id)).rejects.toMatchObject({ code: 'error.trash.invalid' })
  expect(await readFile(join(item.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
})

it.each(['directory', 'metadata'] as const)('does not follow a trash %s link during recovery', async (kind) => {
  const item = await fixture(), moved = join(home, `outside-${kind}`)
  const source = kind === 'directory' ? item.path : item.file
  await rename(source, moved)
  await symlink(moved, source, kind === 'directory' ? 'dir' : 'file')
  await expect(restoreTrash(item.id)).rejects.toMatchObject({ code: 'error.trash.invalid' })
  expect(await readFile(kind === 'directory' ? join(moved, 'audit-orders/SKILL.md') : join(item.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
})

it('restores a complete bundle and flat copy together without losing either file', async () => {
  const item = await fixture()
  expect(await restoreTrash(item.id)).toMatchObject({ id: item.id, name: 'audit-orders' })
  expect(await readFile(join(item.root.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
  expect(await readFile(join(item.root.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
  expect(await listTrash()).toEqual([])
})

it.each(['sync', 'async', 'diagnostics-unavailable'] as const)('keeps restored files and the success receipt when %s logging fails', async (mode) => {
  const item = await fixture()
  const log = vi.fn(() => {
    if (mode === 'sync') throw new Error('Restore log unavailable')
    return Promise.reject(new Error('Restore log unavailable'))
  })
  if (mode === 'diagnostics-unavailable') vi.mocked(console.warn).mockImplementation(() => { throw new Error('Console unavailable') })

  await expect(restoreTrash(item.id, log)).resolves.toMatchObject({ id: item.id, name: 'audit-orders' })

  expect(log).toHaveBeenCalledWith('restore', expect.stringContaining(item.root.path))
  expect(console.warn).toHaveBeenCalledWith('restore', expect.stringContaining(item.root.path))
  expect(await readFile(join(item.root.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
  expect(await readFile(join(item.root.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
  expect(await listTrash()).toEqual([])
})

it('rejects a flat file disguised as a bundle for a different skill name', async () => {
  const item = await fixture()
  await rm(join(item.path, 'audit-orders'), { recursive: true })
  await writeFile(item.file, JSON.stringify({ ...item.metadata, name: 'audit-orders.md', entries: ['audit-orders.md'] }))
  await writeFile(join(item.root.path, 'audit-orders.md'), 'Keep the installed flat skill')
  await expect(restoreTrash(item.id)).rejects.toMatchObject({ code: 'error.trash.invalid' })
  expect(await readFile(join(item.root.path, 'audit-orders.md'), 'utf8')).toBe('Keep the installed flat skill')
  expect(await readFile(join(item.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
})

it('preserves an unexpected destination type instead of replacing an existing empty directory', async () => {
  const item = await fixture()
  await mkdir(join(item.root.path, 'audit-orders.md'))
  expect(await restoreTrash(item.id)).toMatchObject({ ok: false, code: 'error.trash.conflict' })
  expect(await readFile(join(item.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
  expect(await listTrash()).toHaveLength(1)
})

it('keeps the complete trash item when a later move fails and rollback succeeds', async () => {
  const item = await fixture(), original = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    if (source === join(item.path, 'audit-orders.md')) throw Object.assign(new Error('Flat file locked'), { code: 'EACCES' })
    return original(source, destination)
  })
  await expect(restoreTrash(item.id)).rejects.toMatchObject({ code: 'EACCES' })
  expect(await readFile(join(item.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
  expect(await readFile(join(item.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
  expect(await listTrash()).toHaveLength(1)
})

it('reports a trash directory read failure instead of returning an empty collection', async () => {
  const item = await fixture(), failure = Object.assign(new Error('Trash directory unavailable'), { code: 'EACCES' })
  vi.spyOn(fs, 'readdir').mockRejectedValueOnce(failure)
  await expect(listTrash()).rejects.toBe(failure)
  expect(await readFile(join(item.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
})

it('reports an incomplete recovery rollback and retains the files in their actual locations', async () => {
  const item = await fixture(), original = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    if (source === join(item.path, 'audit-orders.md') || source === join(item.root.path, 'audit-orders')) {
      throw Object.assign(new Error('Recovery file locked'), { code: 'EACCES' })
    }
    return original(source, destination)
  })
  await expect(restoreTrash(item.id)).rejects.toMatchObject({ code: 'error.trash.restoreRollbackFailed', params: { path: item.path }, cause: { code: 'EACCES' } })
  expect(await readFile(join(item.root.path, 'audit-orders/SKILL.md'), 'utf8')).toContain('Keep the evidence.')
  expect(await readFile(join(item.path, 'audit-orders.md'), 'utf8')).toBe('Flat skill evidence')
})
