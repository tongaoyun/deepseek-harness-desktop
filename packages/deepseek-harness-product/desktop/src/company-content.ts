/** Immutable, employee-isolated files consumed by the preinstalled native plugins. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { companyContentRelease, COMPANY_CONTENT_MAX_BYTES, COMPANY_CONTENT_MAX_FILES, COMPANY_CONTENT_MAX_PATH_LENGTH, type CompanyContentRelease } from '@deepseek-harness/product/company-content'
import type { CompanyContentRoots } from '@deepseek-harness/product/protocol'

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('公司内容缓存路径不安全')
}

async function verifyCache(directory: string, release: CompanyContentRelease, signal: AbortSignal): Promise<void> {
  const expected = new Map(Object.entries(release.files))
  const directories = new Set(['', 'skills', 'experts'])
  for (const path of expected.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'))
  }
  const walk = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    const stat = await lstat(join(directory, relative))
    if (stat.isSymbolicLink()) throw new Error('公司内容缓存路径不安全')
    if (stat.isDirectory()) {
      if (!directories.has(relative)) throw new Error('公司内容缓存包含未知目录')
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
 * @returns Immutable plugin directories; a Session can retain them across updates.
 */
export async function installCompanyContent(root: string, employeeId: string, value: unknown,
  signal: AbortSignal): Promise<CompanyContentRoots> {
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
        // Windows reports an existing destination directory as EPERM. Verify it before reuse.
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EPERM')) throw error
        await verifyCache(directory, release, signal)
      }
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  signal.throwIfAborted()
  return { skillsRoot: join(directory, 'skills'), expertsRoot: join(directory, 'experts'), version: release.version, sha256: release.sha256 }
}

/** Restore and verify an immutable release without a remote request.
 * @param root - Main-owned company cache.
 * @param employeeId - Authenticated employee.
 * @param version - Version recorded in the latest pointer or Session binding.
 * @param sha256 - Canonical content digest recorded by main.
 * @param signal - Owning lifecycle cancellation.
 * @returns Verified directories; missing or damaged content fails without replacement.
 */
export async function restoreCompanyContent(root: string, employeeId: string, version: string, sha256: string,
  signal: AbortSignal): Promise<CompanyContentRoots> {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('公司内容版本无效')
  const employee = join(root, createHash('sha256').update(employeeId).digest('hex'))
  await privateDirectory(root)
  await privateDirectory(employee)
  const directory = join(employee, sha256)
  const files: Record<string, string> = {}
  let bytes = 0, entries = 0, fileCount = 0
  // Each one-character path segment requires a separator; valid releases can exceed 4,096 directories.
  const maxEntries = COMPANY_CONTENT_MAX_FILES * Math.ceil(COMPANY_CONTENT_MAX_PATH_LENGTH / 2) + 3
  const walk = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    if (relative.length > COMPANY_CONTENT_MAX_PATH_LENGTH) throw new Error('公司内容缓存路径过长')
    const path = join(directory, relative)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('公司内容缓存路径不安全')
    if (info.isDirectory()) {
      for (const child of await readdir(path)) {
        if (++entries > maxEntries) throw new Error('公司内容缓存文件过多')
        await walk(relative ? `${relative}/${child}` : child)
      }
    } else if (relative !== 'release.json') {
      bytes += info.size
      if (!info.isFile() || ++fileCount > COMPANY_CONTENT_MAX_FILES || bytes > COMPANY_CONTENT_MAX_BYTES) throw new Error('公司内容缓存已损坏')
      files[relative] = (await readFile(path, { signal })).toString('base64')
    } else if (!info.isFile() || info.size > 512) throw new Error('公司内容缓存已损坏')
  }
  await walk('')
  const release = version === '0' && Object.keys(files).length === 0 ? companyContentRelease(null)
    : companyContentRelease({ version, sha256, files })
  if (release.sha256 !== sha256) throw new Error('公司内容缓存已损坏')
  await verifyCache(directory, release, signal)
  return { version, sha256, skillsRoot: join(directory, 'skills'), expertsRoot: join(directory, 'experts') }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
