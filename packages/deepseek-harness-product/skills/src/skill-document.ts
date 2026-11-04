/** Management metadata uses the native filesystem skill parser. */
import { parseSkillFrontmatter } from '@deepseek-ai/dsh-skill-filesystem/document'
import { stringify } from 'yaml'
import type { ParsedSkill } from './types.ts'

/** Maximum length of a portable skill category label. */
export const SKILL_CATEGORY_NAME_MAX = 24

/** Normalize one category name for package metadata and local edits.
 * @param value User-authored or imported label.
 * @returns Trimmed label, or undefined for an empty, oversized or multiline value.
 */
export function normalizeSkillCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const label = value.trim()
  return label && label.length <= SKILL_CATEGORY_NAME_MAX && !/[\u0000-\u001f\u007f]/u.test(label) ? label : undefined
}

/** Read metadata for management and imports, leaving invalid files available for diagnosis.
 * @param text Complete SKILL.md text; a UTF-8 BOM is removed for external-source compatibility.
 * @returns Native YAML fields and unchanged body text; invalid YAML exposes no metadata.
 */
export function parseSkillDoc(text: string): ParsedSkill {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let parsed: ReturnType<typeof parseSkillFrontmatter>
  try {
    parsed = parseSkillFrontmatter(src)
  } catch (_error) {
    // Keep the invalid file visible for diagnostics without publishing its metadata.
    parsed = undefined
  }
  const data = parsed?.data ?? {}
  const map = Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return { data, map, body: parsed?.body ?? src, hasFrontmatter: parsed !== undefined }
}

/** Read the optional portable category without changing native invocation permissions.
 * @param data Native frontmatter fields.
 * @returns A short category label, or undefined for absent or invalid metadata.
 */
export function skillCategory(data: Record<string, unknown>): string | undefined {
  const metadata = data.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  return normalizeSkillCategory('category' in metadata ? metadata.category : undefined)
}

/** Include the selected category in an exported skill while retaining other metadata and body text.
 * @param raw Complete valid SKILL.md document.
 * @param category Effective category label; undefined removes the category.
 * @returns Unchanged bytes when the category matches, otherwise a complete YAML document.
 */
export function withSkillCategory(raw: string, category: string | undefined): string {
  const parsed = parseSkillFrontmatter(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  if (!parsed) throw new Error('Invalid SKILL.md frontmatter')
  if (skillCategory(parsed.data) === category) return raw
  const current = parsed.data.metadata
  if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) throw new Error('SKILL.md metadata must be a mapping')
  const metadata = { ...current }
  if (category) Object.assign(metadata, { category })
  else Reflect.deleteProperty(metadata, 'category')
  const data = { ...parsed.data }
  if (Object.keys(metadata).length) data.metadata = metadata
  else Reflect.deleteProperty(data, 'metadata')
  return `---\n${stringify(data)}---\n${parsed.body}`
}
