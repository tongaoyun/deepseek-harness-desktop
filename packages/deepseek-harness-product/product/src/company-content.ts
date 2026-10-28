/** Company releases contain data for native plugins, never plugin executables or credentials. */
import { publishedTeamDocument } from './company-team.ts'
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
  const expertPath = /^experts\/[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u
  const skillPath = /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9_./-]+$/u
  const files: Record<string, string> = {}
  const paths = new Set<string>()
  const expertIds = new Set<string>()
  let bytes = 0
  if (Object.keys(value.files).length > COMPANY_CONTENT_MAX_FILES) throw new Error('公司内容文件过多')
  for (const [path, encoded] of Object.entries(value.files)) {
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(COMPANY_CONTENT_MAX_BYTES / 3) * 4
      || path.length > COMPANY_CONTENT_MAX_PATH_LENGTH
      || !(expertPath.test(path) || skillPath.test(path) || /^teams\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(path))
      || path.split('/').some(part => ['', '.', '..'].includes(part) || part.endsWith('.')
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))
      || paths.has(path.toLowerCase())) throw new Error('公司内容包含非法路径或文件')
    paths.add(path.toLowerCase())
    if (path.startsWith('experts/')) {
      const id = path.slice(path.lastIndexOf('/') + 1)
      if (expertIds.has(id)) throw new Error('公司专家 ID 重复')
      expertIds.add(id)
    }
    const data = Buffer.from(encoded, 'base64')
    bytes += data.byteLength
    if (bytes > COMPANY_CONTENT_MAX_BYTES || data.toString('base64') !== encoded) throw new Error('公司内容大小或编码无效')
    if (path.endsWith('/SKILL.md') || path.startsWith('experts/')) {
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
      const expectedName = path.startsWith('skills/')
        ? path.split('/')[1]
        : path.slice(path.lastIndexOf('/') + 1, -'.md'.length)
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
        || !('name' in metadata) || metadata.name !== expectedName
        || !('description' in metadata) || typeof metadata.description !== 'string'
        || !metadata.description.trim() || /[\r\n]/u.test(metadata.description)) {
        throw new Error(path.endsWith('/SKILL.md')
          ? '公司技能必须包含与目录一致的名称和非空单行字符串简介'
          : '公司专家必须包含与文件名一致的名称和非空单行字符串简介')
      }
      if (path.endsWith('/SKILL.md')) {
        validateSkillInvocation(metadata)
      }
    }
    if (path.startsWith('teams/') && path.length > 91) throw new Error('专家团标识最多 80 个字符')
    if (path.startsWith('teams/')) publishedTeamDocument(new TextDecoder('utf-8', { fatal: true }).decode(data))
    files[path] = encoded
  }
  for (const path of Object.keys(files)) {
    if (path.startsWith('skills/') && files[`${path.split('/').slice(0, 2).join('/')}/SKILL.md`] === undefined) {
      throw new Error('公司技能缺少 SKILL.md')
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
