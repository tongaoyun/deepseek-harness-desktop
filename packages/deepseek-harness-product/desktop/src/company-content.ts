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
  await readCache(directory, release.version, release.sha256, signal)
}

/** Read each file once; bounded batches join all I/O before returning a failure. */
async function readCache(directory: string, version: string, sha256: string, signal: AbortSignal): Promise<void> {
  const files: Record<string, string> = {}
  const directories = new Set<string>()
  const paths = ['']
  let bytes = 0, fileCount = 0
  let metadata: unknown
  const maxEntries = COMPANY_CONTENT_MAX_FILES * Math.ceil(COMPANY_CONTENT_MAX_PATH_LENGTH / 2) + 3
  const visit = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    if (relative.length > COMPANY_CONTENT_MAX_PATH_LENGTH) throw new Error('公司内容缓存路径过长')
    const path = join(directory, relative)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('公司内容缓存路径不安全')
    if (info.isDirectory()) {
      directories.add(relative)
      for (const child of await readdir(path)) {
        if (paths.length >= maxEntries) throw new Error('公司内容缓存文件过多')
        paths.push(relative ? `${relative}/${child}` : child)
      }
      return
    }
    if (!info.isFile()) throw new Error('公司内容缓存已损坏')
    if (relative === 'release.json') {
      if (info.size > 512) throw new Error('公司内容缓存已损坏')
      metadata = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
      return
    }
    bytes += info.size
    if (++fileCount > COMPANY_CONTENT_MAX_FILES || bytes > COMPANY_CONTENT_MAX_BYTES) throw new Error('公司内容缓存已损坏')
    const data = await readFile(path, { signal })
    if (data.length !== info.size) throw new Error('公司内容缓存已损坏')
    files[relative] = data.toString('base64')
  }
  // This is an I/O concurrency ceiling, not a cached permission or content result.
  for (let index = 0; index < paths.length;) {
    const batch = paths.slice(index, index + 8)
    index += batch.length
    const results = await Promise.allSettled(batch.map(visit))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  signal.throwIfAborted()
  if (typeof metadata !== 'object' || metadata === null || !('sha256' in metadata) || metadata.sha256 !== sha256
    || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('公司内容缓存已损坏')
  let release: CompanyContentRelease
  try {
    release = version === '0' && fileCount === 0 ? companyContentRelease(null)
      : companyContentRelease({ version, sha256, files })
  } catch (cause) { throw new Error('公司内容缓存已损坏', { cause }) }
  if (release.sha256 !== sha256) throw new Error('公司内容缓存已损坏')
  const expectedDirectories = new Set(['', 'skills', 'experts'])
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'))
  }
  if (directories.size !== expectedDirectories.size || [...directories].some(path => !expectedDirectories.has(path))) {
    throw new Error('公司内容缓存包含未知或缺失目录')
  }
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
  await readCache(directory, version, sha256, signal)
  return { version, sha256, skillsRoot: join(directory, 'skills'), expertsRoot: join(directory, 'experts') }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
