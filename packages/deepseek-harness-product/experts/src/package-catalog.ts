/** AgentSpec persona adapter; package installation declarations are never executed. */
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { agentSpecManifest, agentSpecPrompt, companyResourceVersionSchema } from '@deepseek-harness/product/company-content'
import type { ExpertSummary } from './expert-contract.ts'
import { z } from 'zod'
import { ZH_DIVISION } from './names.ts'

/** Read literal instructions with the immutable package directory exposed to native file tools.
 * @param root - Fixed package directory.
 * @returns Native persona instructions.
 */
export async function readPackagePrompt(root: string): Promise<{ prompt: string }> {
  const text = async (relative: string, optional = false) => {
    try {
      const path = join(root, relative), info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('专家说明文件无效')
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
      if (value.includes('\0') || !optional && !value.trim()) throw new Error('专家说明文件无效')
      return value
    } catch (error) { if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error }
  }
  return { prompt: agentSpecPrompt(await text('config/SOUL.md'), await text('config/AGENTS.md', true), root) }
}
/** Discover one manifest per expert package; all reference and template files remain available.
 * @param root - Installed expert catalog directory.
 * @returns Metadata indexed by package identifier.
 */
export async function readPackageCatalog(root: string): Promise<Map<string, ExpertSummary>> {
  const experts = new Map<string, ExpertSummary>()
  let metadata: z.infer<typeof companyResourceVersionSchema>[] = []
  try {
    const index = z.object({ resources: z.array(companyResourceVersionSchema), dependencies: z.array(companyResourceVersionSchema) }).parse(JSON.parse(await readFile(join(root, '..', 'catalog.json'), 'utf8')))
    metadata = [...index.resources, ...index.dependencies]
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name)) throw new Error('专家包目录无效')
    const path = join(root, entry.name, 'manifest.json'), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('AgentSpec manifest.json 无效')
    const manifest = agentSpecManifest(await readFile(path, 'utf8'))
    if (manifest.worker.suggested_name !== entry.name) throw new Error('AgentSpec 标识与目录不一致')
    const ref = metadata.find(item => item.resourceKey === 'experts/' + entry.name)
    experts.set(entry.name, { slug: entry.name, name: ref?.name ?? entry.name, nameEn: ref?.name ?? entry.name, description: manifest.description,
      descriptionEn: '', ...(ref ? { packageVersion: ref.version, packageSha256: ref.sha256 } : {}), emoji: '🧩', division: ref?.catalog.division ?? 'specialized', divisionZh: ZH_DIVISION[ref?.catalog.division ?? 'specialized'] ?? 'specialized', avatar: Number(ref?.catalog.avatar ?? 0), custom: false })
  }
  return experts
}
