/** Company releases contain data for native plugins, never plugin executables or credentials. */
import { createHash } from 'node:crypto'

/** One company-wide immutable release of native expert and skill documents. */
export interface CompanyContentRelease {
  readonly version: string
  readonly sha256: string
  readonly files: Readonly<Record<string, string>>
}

/** Maximum decoded bytes in a release, enforced before writing native plugin files. */
export const COMPANY_CONTENT_MAX_BYTES = 32 * 1024 * 1024

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
  if (Object.keys(value.files).length > 2048) throw new Error('公司内容文件过多')
  for (const [path, encoded] of Object.entries(value.files)) {
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(COMPANY_CONTENT_MAX_BYTES / 3) * 4
      || path.length > 240
      || !(expertPath.test(path) || skillPath.test(path))
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
      for (const key of ['name', 'description']) {
        const values = frontmatter.split('\n').filter(line => line.startsWith(`${key}:`))
        const value = values[0]?.slice(key.length + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2')
        if (values.length !== 1 || !value || /^[|>\[\{]/u.test(value)) throw new Error('请填写单行名称和简介')
        if (key === 'name' && path.endsWith('/SKILL.md') && value !== path.split('/')[1]) throw new Error('公司技能名称必须与目录一致')
      }
    }
    files[path] = encoded
  }
  for (const path of Object.keys(files)) {
    if (path.startsWith('skills/') && files[`${path.split('/').slice(0, 2).join('/')}/SKILL.md`] === undefined) {
      throw new Error('公司技能缺少 SKILL.md')
    }
  }
  if (contentDigest(files) !== value.sha256) throw new Error('公司内容校验失败')
  return Object.freeze({ version: value.version, sha256: value.sha256, files: Object.freeze(files) })
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
