/** Immutable personal AgentSpec files; Settings references are updated separately. */
import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentSpecManifest, agentSpecPrompt, companyContentRelease, contentDigest } from '@deepseek-harness/product/company-content'
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
  /** Stage and atomically install an immutable package.
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
    try {
      const prefix = `experts/${slug}/`
      for (const [path, encoded] of Object.entries(files)) {
        const destination = join(staging, path.slice(prefix.length))
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, Buffer.from(encoded, 'base64'), { flag: 'wx', mode: 0o600 })
      }
      await writeFile(join(staging, '.package-index.json'), JSON.stringify(Object.keys(files)), { flag: 'wx', mode: 0o600 })
      try { await rename(staging, target) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code)))) throw error
        await this.readFiles(slug, hash)
      }
    } finally { await rm(staging, { recursive: true, force: true }) }
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
  /** Read every indexed file and verify the content digest.
   * @param slug - Package identifier.
   * @param hash - Expected full SHA-256.
   * @returns Validated base64-encoded package files.
   */
  async readFiles(slug: string, hash: string): Promise<Record<string, string>> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid expert package reference')
    const root = join(await this.root(), slug, hash)
    await assertDirectory(root)
    const indexPath = join(root, '.package-index.json')
    const info = await lstat(indexPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('个人专家索引损坏')
    const index: unknown = JSON.parse(await readFile(indexPath, 'utf8'))
    if (!Array.isArray(index) || index.length > 2048 || index.some(path => typeof path !== 'string' || !path.startsWith(`experts/${slug}/`))) throw new Error('个人专家索引损坏')
    const files: Record<string, string> = {}
    let bytes = 0
    for (const entry of index) {
      if (typeof entry !== 'string' || entry.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(entry)) throw new Error('个人专家文件路径无效')
      const relative = entry.slice(`experts/${slug}/`.length)
      const parts = relative.split('/')
      for (let i = 1; i < parts.length; i++) await assertDirectory(join(root, ...parts.slice(0, i)))
      const path = join(root, relative), info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || (bytes += info.size) > 32 * 1024 * 1024) throw new Error('个人专家文件损坏')
      files[entry] = (await readFile(path)).toString('base64')
    }
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
