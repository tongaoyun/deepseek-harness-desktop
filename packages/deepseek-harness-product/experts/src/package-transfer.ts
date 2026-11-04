/** AgentSpec package import and export over native Remote. */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentSpecManifest, companyContentRelease, contentDigest } from '@deepseek-harness/product/company-content'
import { customExpertInputSchema, type CustomExpertInput } from './expert-contract.ts'
import { expertDescriptionSummary } from './package-manifest.ts'

/** Product package access, including complete reference and template files. */
export interface ExpertPackageSource {
  /** Read the selected source without mixing published versions or personal package digests.
   * @param slug - Selected expert identifier.
   * @param signal - Native request cancellation.
   * @returns Complete package files and catalog display metadata.
   */
  read(slug: string, signal: AbortSignal): Promise<{ resourceKey: string; files: Record<string, string>; catalog: Record<string, string> }>
}
/** Host-owned package source service. */
export const EXPERT_PACKAGE_SOURCE = 'agencyExpertPackages'

/** Decode one validated AgentSpec package into editable fields.
 * @param files - Complete base64-encoded package files.
 * @returns Editable expert draft.
 */
export function importExpertPackage(files: Record<string, string>): CustomExpertInput {
  const entries = Object.keys(files).filter(path => /^experts\/[^/]+\/manifest\.json$/u.test(path))
  if (entries.length !== 1) throw new Error('请选择一个完整的 AgentSpec 包')
  const prefix = entries[0].slice(0, -'manifest.json'.length)
  if (Object.keys(files).some(path => !path.startsWith(prefix))) throw new Error('一次只能导入一个专家包')
  const validated = companyContentRelease({ version: '1.0.0', sha256: contentDigest(files), files }).files
  const text = (path: string) => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(validated[prefix + path] ?? '', 'base64'))
  const manifest = agentSpecManifest(text('manifest.json'))
  const resources = Object.fromEntries(Object.entries(validated).filter(([path]) => !['manifest.json', 'config/SOUL.md', 'config/AGENTS.md'].includes(path.slice(prefix.length))).map(([path, encoded]) => [path.slice(prefix.length), encoded]))
  return customExpertInputSchema.parse({ name: manifest.worker.suggested_name.slice(0, 40), description: expertDescriptionSummary(manifest.description),
    division: 'specialized', prompt: text('config/SOUL.md'),
    ...Object.hasOwn(validated, prefix + 'config/AGENTS.md') ? { agents: text('config/AGENTS.md') } : {},
    manifest: text('manifest.json'), resources })
}

/** Read a complete immutable company package without following symbolic links.
 * @param root - Installed expert catalog directory.
 * @param slug - Package identifier.
 * @param signal - Native request cancellation.
 * @returns Validated base64-encoded package files.
 */
export async function readExpertPackage(root: string, slug: string, signal: AbortSignal): Promise<Record<string, string>> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error('专家标识无效')
  const files: Record<string, string> = {}
  let bytes = 0
  const walk = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    const target = join(root, slug, relative), info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error('专家包包含不安全路径')
    if (info.isDirectory()) {
      for (const name of await readdir(target)) await walk(relative ? relative + '/' + name : name)
    } else {
      if (!info.isFile() || (bytes += info.size) > 32 * 1024 * 1024 || Object.keys(files).length >= 2048) throw new Error('专家包超过限制')
      files[`experts/${slug}/${relative}`] = (await readFile(target, { signal })).toString('base64')
    }
  }
  await walk('')
  return { ...companyContentRelease({ version: '1.0.0', sha256: contentDigest(files), files }).files }
}
