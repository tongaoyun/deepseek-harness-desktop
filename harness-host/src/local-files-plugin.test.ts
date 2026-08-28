import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverAuthorizedRoots, LocalFileBridge } from './local-files-plugin.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('LocalFileBridge', () => {
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
