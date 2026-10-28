/** Management metadata uses the native filesystem skill parser. */
import { parseSkillFrontmatter } from '@deepseek-ai/dsh-skill-filesystem/document'
import type { ParsedSkill } from './types.ts'

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
