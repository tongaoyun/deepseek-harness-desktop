/** Immutable personal AgentSpec files; Settings references are updated separately. */
import { mkdir, lstat, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentSpecManifest, agentSpecPrompt, companyContentRelease, contentDigest, COMPANY_CONTENT_MAX_BYTES, COMPANY_CONTENT_MAX_FILES } from '@deepseek-harness/product/company-content'
import { readContentFile } from '@deepseek-harness/product/content-files'
import { customExpertInputSchema, type CustomExpert, type CustomExpertInput } from './expert-contract.ts'
import { expertPackageManifest } from './package-manifest.ts'

/** Encode an editable AgentSpec package without dropping resource files.
 * @param slug - Immutable package identifier.
 * @param input - Validated editor fields and resources.
 * @returns Complete base64-encoded package files.
 */
export function expertPackageFiles(slug: string, input: CustomExpertInput): Record<string, string> {
  const value = customExpertInputSchema.parse(input)
  const manifest = expertPackageManifest(slug, value.description, value.manifest)
  if (agentSpecManifest(manifest).worker.suggested_name !== slug) throw new Error('AgentSpec 标识与专家不一致')
  const files: Record<string, string> = { [`experts/${slug}/manifest.json`]: Buffer.from(manifest).toString('base64'),
    [`experts/${slug}/config/SOUL.md`]: Buffer.from(value.prompt).toString('base64') }
  if (value.agents !== undefined) files[`experts/${slug}/config/AGENTS.md`] = Buffer.from(value.agents).toString('base64')
  for (const [path, encoded] of Object.entries(value.resources)) {
    if (['manifest.json', 'config/SOUL.md', 'config/AGENTS.md', '.package-index.json'].includes(path)) throw new Error('附件路径与专家说明冲突')
    files[`experts/${slug}/${path}`] = encoded
  }
  return { ...companyContentRelease({ version: '1.0.0', sha256: contentDigest(files), files }).files }
}

/** Employee-isolated package storage, addressed by content digest. */
export class ExpertPackageStore {
  /** Create employee-isolated package storage.
   * @param root - Resolves the currently authenticated employee directory.
   */
  constructor(private readonly root: () => Promise<string>) {}
  /** Stage and atomically install an immutable package; failed cleanup retains the installation failure as its cause.
   * @param slug - Package identifier.
   * @param input - Complete editable package.
   * @returns Immutable version and full digest.
   */
  async save(slug: string, input: CustomExpertInput): Promise<{ packageVersion: string; packageSha256: string }> {
    const files = expertPackageFiles(slug, input), hash = contentDigest(files)
    const root = await this.root()
    await privateDirectory(root)
    const parent = join(root, slug)
    await privateDirectory(parent)
    const target = join(parent, hash)
    let exists = true
    try { await lstat(target) } catch (error) { if (!missing(error)) throw error; exists = false }
    if (exists) { await this.readFiles(slug, hash); return { packageVersion: `0.0.0-${hash.slice(0, 56)}`, packageSha256: hash } }
    const staging = join(parent, `.staging-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    let staged = true
    try {
      const prefix = `experts/${slug}/`
      for (const [path, encoded] of Object.entries(files)) {
        const destination = join(staging, path.slice(prefix.length))
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, Buffer.from(encoded, 'base64'), { flag: 'wx', mode: 0o600 })
      }
      await writeFile(join(staging, '.package-index.json'), JSON.stringify(Object.keys(files)), { flag: 'wx', mode: 0o600 })
      try { await rename(staging, target); staged = false }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code)))) throw error
        await this.readFiles(slug, hash)
      }
    } catch (error) {
      try { await rm(staging, { recursive: true, force: true }) }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '个人专家文件写入失败，且暂存目录未清理', { cause: error })
      }
      throw error
    }
    if (staged) await rm(staging, { recursive: true, force: true })
    return { packageVersion: `0.0.0-${hash.slice(0, 56)}`, packageSha256: hash }
  }
  /** Read and validate a saved package for editing.
   * @param expert - Settings metadata with an exact package reference.
   * @returns Complete editable fields.
   */
  async read(expert: CustomExpert): Promise<CustomExpertInput & { slug: string }> {
    const files = await this.readFiles(expert.slug, expert.packageSha256)
    const prefix = `experts/${expert.slug}/`
    const text = (path: string) => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(files[prefix + path] ?? '', 'base64'))
    const { packageVersion: _version, packageSha256: _hash, ...metadata } = expert
    const resources = Object.fromEntries(Object.entries(files).filter(([path]) => !['manifest.json', 'config/SOUL.md', 'config/AGENTS.md'].includes(path.slice(prefix.length))).map(([path, value]) => [path.slice(prefix.length), value]))
    return { ...metadata, prompt: text('config/SOUL.md'),
      ...Object.hasOwn(files, prefix + 'config/AGENTS.md') ? { agents: text('config/AGENTS.md') } : {},
      manifest: text('manifest.json'), resources }
  }
  /** Compose literal instructions with the resource root.
   * @param expert - Exact expert reference.
   * @returns Native subagent instructions.
   */
  async prompt(expert: CustomExpert): Promise<string> {
    const value = await this.read(expert)
    return agentSpecPrompt(value.prompt, value.agents ?? '', join(await this.root(), expert.slug, expert.packageSha256))
  }
  /** Verify the complete saved directory and read every indexed file without following symbolic links.
   * @param slug - Package identifier.
   * @param hash - Expected full SHA-256.
   * @param signal - Optional cancellation for directory checks and bounded file reads.
   * @returns Validated base64-encoded package files; unknown entries, duplicate paths and digest changes fail without modifying storage.
   */
  async readFiles(slug: string, hash: string, signal?: AbortSignal): Promise<Record<string, string>> {
    signal?.throwIfAborted()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid expert package reference')
    const employeeRoot = await this.root(), parent = join(employeeRoot, slug), root = join(parent, hash)
    await assertDirectory(employeeRoot)
    await assertDirectory(parent)
    await assertDirectory(root)
    const indexPath = join(root, '.package-index.json')
    const index: unknown = JSON.parse((await readContentFile(indexPath, 512 * 1024, signal)).toString('utf8'))
    if (!Array.isArray(index) || index.length === 0 || index.length > COMPANY_CONTENT_MAX_FILES) throw new Error('个人专家索引损坏')
    const paths = new Set<string>()
    const directories = new Map<string, Set<string>>([['', new Set(['.package-index.json'])]])
    for (const entry of index) {
      if (typeof entry !== 'string' || !entry.startsWith(`experts/${slug}/`) || paths.has(entry)) throw new Error('个人专家索引损坏')
      if (entry.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(entry)) throw new Error('个人专家文件路径无效')
      paths.add(entry)
      const parts = entry.slice(`experts/${slug}/`.length).split('/')
      for (let i = 0; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/'), names = directories.get(directory) ?? new Set<string>()
        names.add(parts[i])
        directories.set(directory, names)
      }
    }
    for (const [relative, expected] of directories) {
      signal?.throwIfAborted()
      const directory = join(root, relative)
      if (relative) await assertDirectory(directory)
      const actual = await readdir(directory)
      if (actual.length !== expected.size || actual.some(name => !expected.has(name))) {
        throw new Error('个人专家文件目录与保存版本不一致，请重新导入或编辑后保存')
      }
    }
    const files: Record<string, string> = {}
    let bytes = 0
    for (const entry of paths) {
      signal?.throwIfAborted()
      const relative = entry.slice(`experts/${slug}/`.length)
      const content = await readContentFile(join(root, relative), COMPANY_CONTENT_MAX_BYTES - bytes, signal)
      bytes += content.byteLength
      files[entry] = content.toString('base64')
    }
    signal?.throwIfAborted()
    return { ...companyContentRelease({ version: `0.0.0-${hash.slice(0, 56)}`, sha256: hash, files }).files }
  }
}
async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  await assertDirectory(path)
}
async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('个人专家目录不安全')
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
