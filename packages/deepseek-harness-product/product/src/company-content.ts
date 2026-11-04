export { agentSpecManifest, agentSpecManifestSchema, agentSpecPrompt, type AgentSpecManifest } from './agent-spec.ts'
import { agentSpecManifest } from './agent-spec.ts'
/** Company releases contain data for native plugins, never plugin executables or credentials. */
import { publishedTeamDocument } from './company-team.ts'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { isCollection, parseDocument, visit } from 'yaml'

/** One company-wide immutable release of native expert and skill documents. */
export interface CompanyContentRelease {
  readonly version: string
  readonly sha256: string
  readonly files: Readonly<Record<string, string>>
}

/** Maximum decoded bytes in a release, enforced before writing native plugin files. */
export const COMPANY_CONTENT_MAX_BYTES = 32 * 1024 * 1024
/** Maximum ordinary files in a company release, excluding main-owned cache metadata. */
export const COMPANY_CONTENT_MAX_FILES = 2048
/** Maximum characters in a portable relative content path. */
export const COMPANY_CONTENT_MAX_PATH_LENGTH = 240

/** Validate downloaded files and their canonical digest before any filesystem write.
 * @param value - Authenticated server response, or null before the first publication.
 * @returns An immutable, validated release.
 */
export function companyContentRelease(value: unknown): CompanyContentRelease {
  if (value === null) return { version: '0', sha256: contentDigest({}), files: {} }
  if (typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || typeof value.version !== 'string' || value.version.length > 80
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
    || !('sha256' in value) || typeof value.sha256 !== 'string'
    || !('files' in value) || typeof value.files !== 'object' || value.files === null || Array.isArray(value.files)) {
    throw new Error('公司内容格式无效')
  }
  const expertRe = /^(?:experts\/[a-z0-9]+(?:-[a-z0-9]+)*|expert-versions\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-f0-9]{64})\/[^\\\u0000-\u001f:]+$/u
  const skillPath = /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/[^\\\u0000-\u001f:]+$/u
  const files: Record<string, string> = {}
  const paths = new Set<string>()
  let bytes = 0
  if (Object.keys(value.files).length > COMPANY_CONTENT_MAX_FILES) throw new Error('公司内容文件过多')
  for (const [path, encoded] of Object.entries(value.files)) {
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(COMPANY_CONTENT_MAX_BYTES / 3) * 4
      || path.length > COMPANY_CONTENT_MAX_PATH_LENGTH
      || !(path === 'catalog.json' || expertRe.test(path) || skillPath.test(path) || /^teams\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(path))
      || path.split('/').some(part => ['', '.', '..'].includes(part) || part.endsWith('.')
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))
      || paths.has(path.toLowerCase())) throw new Error('公司内容包含非法路径或文件')
    paths.add(path.toLowerCase())
    const data = Buffer.from(encoded, 'base64')
    bytes += data.byteLength
    if (bytes > COMPANY_CONTENT_MAX_BYTES || data.toString('base64') !== encoded) throw new Error('公司内容大小或编码无效')
    if (path.endsWith('/SKILL.md') && path.startsWith('skills/')) {
      if (data.byteLength > 128 * 1024) throw new Error('公司技能或专家说明过长')
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(data).replaceAll('\r\n', '\n')
      const document = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(markdown)
      const [, frontmatter, body] = document ?? []
      if (!frontmatter || !body?.trim() || markdown.includes('\0')) throw new Error('公司技能或专家说明无效')
      const parsed = parseDocument(frontmatter, { schema: 'core' })
      if (parsed.errors.length || parsed.warnings.length) {
        throw new Error(path.endsWith('/SKILL.md') ? '公司技能 YAML 格式无效' : '公司专家 YAML 格式无效')
      }
      visit(parsed, (_, node, ancestors) => {
        if (isCollection(node) && ancestors.filter(isCollection).length >= 64) {
          throw new Error(path.endsWith('/SKILL.md') ? '公司技能 YAML 嵌套最多 64 层' : '公司专家 YAML 嵌套最多 64 层')
        }
      })
      const metadata: unknown = parsed.toJS({ maxAliasCount: 0 })
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
        || !('name' in metadata) || typeof metadata.name !== 'string' || !metadata.name.trim() || /[\r\n]/u.test(metadata.name)
        || path.startsWith('skills/') && metadata.name !== path.split('/')[1]
        || !('description' in metadata) || typeof metadata.description !== 'string'
        || !metadata.description.trim() || /[\r\n]/u.test(metadata.description)) {
        throw new Error(path.endsWith('/SKILL.md')
          ? '公司技能必须包含与目录一致的名称和非空单行字符串简介'
          : '公司专家必须包含非空单行字符串名称和简介')
      }
      if (path.endsWith('/SKILL.md')) {
        validateSkillInvocation(metadata)
      }
    }
    if (path.startsWith('teams/') && path.length > 91) throw new Error('专家团标识最多 80 个字符')
    if (path.startsWith('teams/')) {
      const team = publishedTeamDocument(new TextDecoder('utf-8', { fatal: true }).decode(data))
      const key = path.slice('teams/'.length, -'.json'.length)
      if (team.id !== key) throw new Error('专家团标识与文件名不一致')
    }
    files[path] = encoded
  }
  for (const path of Object.keys(files)) {
    if (path.startsWith('skills/') && files[`${path.split('/').slice(0, 2).join('/')}/SKILL.md`] === undefined) {
      throw new Error('公司技能缺少 SKILL.md')
    }
  }
  const expertRoots = new Set(Object.keys(files).filter(path => path.startsWith('experts/') || path.startsWith('expert-versions/'))
    .map(path => path.split('/').slice(0, path.startsWith('experts/') ? 2 : 3).join('/')))
  for (const root of expertRoots) {
    const manifest = files[`${root}/manifest.json`], soul = files[`${root}/config/SOUL.md`]
    if (manifest === undefined || soul === undefined) throw new Error('专家包缺少 manifest.json 或 config/SOUL.md')
    const metadata = agentSpecManifest(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(manifest, 'base64')))
    const id = root.split('/')[1]
    if (metadata.worker.suggested_name !== id) throw new Error('AgentSpec 标识与专家包目录不一致')
    for (const path of [`${root}/config/SOUL.md`, `${root}/config/AGENTS.md`]) {
      const encoded = files[path]
      if (encoded === undefined) continue
      const data = Buffer.from(encoded, 'base64')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      if (data.length > 128 * 1024 || text.includes('\0') || path.endsWith('/SOUL.md') && !text.trim()) throw new Error('专家说明无效')
    }
  }
  const directories = new Map<string, string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      const key = parent.toLowerCase()
      if (paths.has(key)) throw new Error('公司内容存在文件与目录路径冲突')
      if (directories.has(key) && directories.get(key) !== parent) throw new Error('公司内容存在目录大小写冲突')
      directories.set(key, parent)
    }
  }
  if (contentDigest(files) !== value.sha256) throw new Error('公司内容校验失败')
  return Object.freeze({ version: value.version, sha256: value.sha256, files: Object.freeze(files) })
}

/** Match the native file provider's invocation fields at the publication boundary. */
function validateSkillInvocation(metadata: object): void {
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(metadata, key)) throw new Error(`公司技能调用配置不支持 ${key}，请使用原生字段`)
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (!Object.hasOwn(metadata, key)) continue
    const value: unknown = Reflect.get(metadata, key)
    if (typeof value === 'boolean' || value === 0 || value === 1
      || typeof value === 'string' && /^(?:true|false|yes|no|on|off|0|1)$/iu.test(value)) continue
    throw new Error(`公司技能调用配置 ${key} 必须是布尔值`)
  }
}

/** Canonical file digest shared with the company's publication service.
 * @param files - Safe relative paths and canonical base64 contents.
 * @returns SHA-256 of sorted path, NUL, content hash and LF records.
 */
export function contentDigest(files: Readonly<Record<string, string>>): string {
  const canonical = Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, encoded]) => `${path}\0${createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex')}\n`).join('')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Published resource coordinates and catalog presentation, with no Nacos credentials. */
export const companyResourceVersionSchema = z.object({
  resourceKey: z.string().regex(/^(?:skills|experts|teams)\/[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  version: z.string().regex(/^0\.0\.0-[a-f0-9]{56}$/u), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  name: z.string().min(1).max(1000), description: z.string().min(1).max(2000),
  fileCount: z.number().int().min(1).max(COMPANY_CONTENT_MAX_FILES), publishedAt: z.string(),
  catalog: z.object({ name: z.string().trim().min(1).max(80).optional(), division: z.string().trim().min(1).max(80).optional(),
    avatar: z.string().regex(/^(?:[0-9]|[12][0-9]|3[0-5])$/u).optional() }).strict()
    .refine(value => Object.values(value).every(text => text === undefined || !/[\u0000-\u001f\u007f]/u.test(text))),
  dependencies: z.record(z.string().regex(/^experts\/[a-z0-9]+(?:-[a-z0-9]+)*$/u), z.string().regex(/^[a-f0-9]{64}$/u)),
}).strict().refine(value => value.version === `0.0.0-${value.sha256.slice(0, 56)}` && Object.keys(value.dependencies).length <= 8)
/** Exact server-owned resource version. */
export type CompanyResourceVersion = z.infer<typeof companyResourceVersionSchema>
/** Version index returned by the company catalog endpoint. */
export interface CompanyContentIndex {
  readonly protocolVersion: 2
  readonly version: string
  readonly sha256: string
  readonly resources: readonly CompanyResourceVersion[]
  readonly dependencies: readonly CompanyResourceVersion[]
}
const indexSchema = z.object({ protocolVersion: z.literal(2), version: z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), resources: z.array(companyResourceVersionSchema).max(2048),
  dependencies: z.array(companyResourceVersionSchema).max(16384), publishedAt: z.string(),
}).strict()
/** Validate an index and every pinned team dependency before downloading files.
 * @param value - Employee-authenticated catalog response.
 * @returns An immutable resource index; obsolete protocols require a desktop update.
 */
export function companyContentIndex(value: unknown): CompanyContentIndex | null {
  if (value === null) return null
  const parsed = indexSchema.safeParse(value)
  if (!parsed.success) throw new Error('公司内容协议已更新，请更新桌面端后重试。')
  const index = parsed.data
  if (new Set(index.resources.map(item => item.resourceKey)).size !== index.resources.length
    || new Set(index.dependencies.map(item => item.resourceKey + '/' + item.sha256)).size !== index.dependencies.length
    || index.dependencies.some(item => !item.resourceKey.startsWith('experts/'))) throw new Error('公司内容版本索引无效')
  const records = [
    ...index.resources.map(item => `resource\0${item.resourceKey}\0${item.version}\0${item.sha256}\n`),
    ...index.dependencies.map(item => `dependency\0${item.resourceKey}\0${item.version}\0${item.sha256}\n`),
    ...index.resources.flatMap(item => Object.entries(item.catalog).map(([key, value]) => `catalog\0${item.resourceKey}\0${key}\0${value}\n`)),
  ].sort().join('')
  if (createHash('sha256').update(records).digest('hex') !== index.sha256) throw new Error('公司内容版本索引校验失败')
  const required = new Set<string>()
  for (const item of index.resources) for (const [key, hash] of Object.entries(item.dependencies)) {
    required.add(key + '/' + hash)
    if (!index.dependencies.some(ref => ref.resourceKey === key && ref.sha256 === hash)) throw new Error('专家团固定版本缺失')
  }
  if (index.dependencies.some(ref => !required.has(ref.resourceKey + '/' + ref.sha256))) throw new Error('公司内容存在未引用的依赖')
  return Object.freeze(index)
}
