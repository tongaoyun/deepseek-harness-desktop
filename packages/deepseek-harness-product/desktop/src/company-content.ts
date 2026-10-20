/** Immutable, employee-isolated files consumed by the preinstalled native plugins. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { companyContentRelease, type CompanyContentRelease } from '@deepseek-harness/product/company-content'

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('公司内容缓存路径不安全')
}

async function verifyCache(directory: string, release: CompanyContentRelease, signal: AbortSignal): Promise<void> {
  const expected = new Map(Object.entries(release.files))
  const walk = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    const stat = await lstat(join(directory, relative))
    if (stat.isSymbolicLink()) throw new Error('公司内容缓存路径不安全')
    if (stat.isDirectory()) {
      for (const child of await readdir(join(directory, relative))) await walk(relative ? `${relative}/${child}` : child)
      return
    }
    if (!stat.isFile()) throw new Error('公司内容缓存已损坏')
    if (relative === 'release.json') {
      if (stat.size > 512) throw new Error('公司内容缓存已损坏')
      const metadata: unknown = JSON.parse(await readFile(join(directory, relative), { encoding: 'utf8', signal }))
      if (typeof metadata !== 'object' || metadata === null || !('sha256' in metadata) || metadata.sha256 !== release.sha256) throw new Error('公司内容缓存已损坏')
      return
    }
    const encoded = expected.get(relative)
    if (encoded === undefined) throw new Error('公司内容缓存已损坏')
    const data = Buffer.from(encoded, 'base64')
    if (stat.size !== data.length || !(await readFile(join(directory, relative), { signal })).equals(data)) throw new Error('公司内容缓存已损坏')
    expected.delete(relative)
  }
  await walk('')
  if (expected.size) throw new Error('公司内容缓存已损坏')
  await lstat(join(directory, 'release.json'))
}

/** Stage a complete release without overwriting files held by a running Host.
 * @param root - Existing main-owned user-data directory's private cache child.
 * @param employeeId - Authenticated employee, never supplied by a Renderer.
 * @param value - Authenticated server release.
 * @param signal - Startup cancellation.
 * @returns Plugin directories fixed for this Host lifetime.
 */
export async function installCompanyContent(root: string, employeeId: string, value: unknown, signal: AbortSignal) {
  const release = companyContentRelease(value)
  signal.throwIfAborted()
  await privateDirectory(root)
  const employee = join(root, createHash('sha256').update(employeeId).digest('hex'))
  await privateDirectory(employee)
  const directory = join(employee, release.sha256)
  try {
    await lstat(directory)
    await verifyCache(directory, release, signal)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    // Missing descendants are damage, never permission to replace a published directory.
    try { await lstat(directory); throw new Error('公司内容缓存已损坏') }
    catch (missing) { if (!hasCode(missing, 'ENOENT')) throw missing }
    const staging = join(employee, `.staging-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    try {
      await mkdir(join(staging, 'skills'), { mode: 0o700 })
      await mkdir(join(staging, 'experts'), { mode: 0o700 })
      for (const [path, encoded] of Object.entries(release.files)) {
        signal.throwIfAborted()
        const target = join(staging, path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, Buffer.from(encoded, 'base64'), { flag: 'wx', mode: 0o600, signal })
      }
      await writeFile(join(staging, 'release.json'), JSON.stringify({ version: release.version, sha256: release.sha256 }), { mode: 0o600, signal })
      signal.throwIfAborted()
      try { await rename(staging, directory) }
      catch (error) {
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error
        await verifyCache(directory, release, signal)
      }
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  signal.throwIfAborted()
  return { skillsRoot: join(directory, 'skills'), expertsRoot: join(directory, 'experts'), version: release.version }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
