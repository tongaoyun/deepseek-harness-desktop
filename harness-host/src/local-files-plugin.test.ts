import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverAuthorizedRoots, localFileMutationRequiresApproval, LocalFileBridge } from './local-files-plugin.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('LocalFileBridge', () => {
  it('asks only before overwrites, moves and deletes', () => {
    expect(localFileMutationRequiresApproval('local_files_write_text', { overwrite: false })).toBe(false)
    expect(localFileMutationRequiresApproval('local_files_create_directory', {})).toBe(false)
    expect(localFileMutationRequiresApproval('local_files_copy', { overwrite: false })).toBe(false)
    expect(localFileMutationRequiresApproval('local_files_write_text', { overwrite: true })).toBe(true)
    expect(localFileMutationRequiresApproval('local_files_move', {})).toBe(true)
    expect(localFileMutationRequiresApproval('local_files_delete', {})).toBe(true)
  })

  it('lists and reads only approved UTF-8 text files', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'reports'))
    await writeFile(join(root, 'reports', 'daily.csv'), 'sku,sales\nA-1,8\n')
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    const listing = await bridge.list('local-root-1', '', 2)
    expect(listing.entries).toContainEqual({ path: 'reports', type: 'directory' })
    expect(listing.entries).toContainEqual({ path: 'reports/daily.csv', type: 'file', size: 16 })

    const file = await bridge.readText('local-root-1', 'reports/daily.csv')
    expect(file.content).toContain('A-1,8')
    expect(file.path).toBe('reports/daily.csv')
    expect(file.rootName).toBeTruthy()
  })

  it('searches names and text content without traversing dependency folders', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'reports'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'reports', 'weekly.md'), '库存正常\nSKU-A 库存偏低\n')
    await writeFile(join(root, 'node_modules', 'ignored.md'), 'SKU-A')
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    const result = await bridge.search('local-root-1', 'sku-a')

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ path: 'reports/weekly.md', type: 'file' })
    expect(result.matches[0]?.matches[0]).toMatchObject({ line: 2, text: 'SKU-A 库存偏低' })
  })

  it('reads large text files in deterministic chunks', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'large.txt'), 'a'.repeat(300_000))
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    const first = await bridge.readText('local-root-1', 'large.txt')
    const second = await bridge.readText('local-root-1', 'large.txt', first.nextOffset!)

    expect(first.content).toHaveLength(256 * 1024)
    expect(first.truncated).toBe(true)
    expect(second.content).toHaveLength(300_000 - 256 * 1024)
    expect(second.truncated).toBe(true)
    expect(second.nextOffset).toBeUndefined()
  })

  it('rejects traversal, unapproved types and credential files', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'authorized')
    await mkdir(root)
    await writeFile(join(parent, 'outside.txt'), 'outside')
    await writeFile(join(root, 'archive.zip'), 'not really a zip')
    await writeFile(join(root, '.env'), 'TOKEN=secret')
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    const listing = await bridge.list('local-root-1')
    expect(listing.entries.map((entry) => entry.path)).not.toContain('.env')
    await expect(bridge.readText('local-root-1', '../outside.txt')).rejects.toThrow('escapes')
    await expect(bridge.readText('local-root-1', 'archive.zip')).rejects.toThrow('approved')
    await expect(bridge.readText('local-root-1', '.env')).rejects.toThrow('Credential')
  })

  it.skipIf(process.platform === 'win32')('rejects symlinks that escape an authorized root', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'authorized')
    await mkdir(root)
    await writeFile(join(parent, 'outside.txt'), 'outside')
    await symlink(join(parent, 'outside.txt'), join(root, 'outside-link.txt'))
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    await expect(bridge.readText('local-root-1', 'outside-link.txt')).rejects.toThrow('symlink escapes')
  })

  it('creates, writes, copies, moves and deletes only below the authorized root', async () => {
    const root = await temporaryDirectory()
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    await bridge.createDirectory('local-root-1', 'exports/daily')
    await bridge.writeText('local-root-1', 'exports/daily/report.md', '# report', false)
    await bridge.copy('local-root-1', 'exports/daily/report.md', 'exports/report-copy.md', false)
    await bridge.move('local-root-1', 'exports/report-copy.md', 'exports/report-final.md')
    expect((await bridge.readText('local-root-1', 'exports/report-final.md')).content).toBe('# report')
    await bridge.delete('local-root-1', 'exports/report-final.md', false)
    await expect(bridge.readText('local-root-1', 'exports/report-final.md')).rejects.toThrow()
  })

  it('keeps recoverable copies before overwriting and deleting files', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'report.md'), 'before')
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    const overwritten = await bridge.writeText('local-root-1', 'report.md', 'after', true) as { backupPath: string }
    expect((await bridge.readText('local-root-1', overwritten.backupPath)).content).toBe('before')
    const deleted = await bridge.delete('local-root-1', 'report.md', false) as { backupPath: string }
    expect((await bridge.readText('local-root-1', deleted.backupPath)).content).toBe('after')
  })

  it('blocks mutation of credential files and traversal destinations', async () => {
    const root = await temporaryDirectory()
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([root]))

    await expect(bridge.writeText('local-root-1', '.env', 'SECRET=x', false)).rejects.toThrow('Credential')
    await expect(bridge.writeText('local-root-1', '../outside.txt', 'outside', false)).rejects.toThrow('escapes')
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'xiaoyin-local-files-'))
  temporaryDirectories.push(path)
  return path
}
