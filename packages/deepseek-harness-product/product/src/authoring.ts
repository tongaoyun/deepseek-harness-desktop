/** Standard personal extension package generation and YAML parsing. */
import { z } from 'zod'
import { parseDocument, stringify } from 'yaml'
import { ExtensionDraftSchema, skillCatalogSummary, type ExtensionDraft } from './extension-draft.ts'
export { EXTENSION_CATEGORIES, ExtensionDraftSchema, ExtensionImportDraftSchema } from './extension-draft.ts'
export type { ExtensionDraft, ExtensionImportPreview, ExtensionSaveResult } from './extension-draft.ts'

/** Parse standard SKILL.md frontmatter with bounded YAML and no executable tags.
 * @param markdown Standard skill source.
 * @param bundled Whether the source is a kit skill with the 256 KiB limit.
 * @returns Validated identifier, description and Markdown body.
 */
export function parseSkillMarkdown(markdown: string, bundled = false): { id: string; summary: string; body: string; description?: string } {
  const normalized = markdown.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n---\n', 4)
  if (!normalized.startsWith('---\n') || end < 0 || new TextEncoder().encode(markdown).length > (bundled ? 262_144 : 65_536)) throw new Error('Invalid SKILL.md frontmatter')
  const document = parseDocument(normalized.slice(4, end), { uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('Invalid SKILL.md YAML')
  const fields = z.object({ name: bundled ? z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) : ExtensionDraftSchema.shape.id,
    description: z.string().min(1).max(bundled ? 262_144 : 300) })
    .parse(document.toJS({ maxAliasCount: 0 }))
  const body = normalized.slice(end + 5).trim()
  if (!body) throw new Error('Skill Markdown body is empty')
  return { id: fields.name, summary: bundled ? skillCatalogSummary(fields.description) : fields.description, body,
    ...bundled ? { description: fields.description } : {} }
}

/** Generate standard manifests and Markdown from a validated form.
 * @param draft Validated edit, with catalog skill content resolved by main.
 * @param originals Main-owned original Markdown indexed by destination path; extra frontmatter is retained.
 * @returns Generated text files and immutable release metadata before hashing.
 */
export function extensionFiles(draft: ExtensionDraft, originals: Readonly<Record<string, string>> = {}): {
  files: Record<string, string>
  release: Record<string, unknown>
} {
  if (draft.kind === 'connector') throw new Error('Connectors have no content archive')
  const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
  const refs = draft.kind === 'skill' ? draft : {
    connectorRefs: draft.skills.flatMap(value => value.connectorRefs), requiredTools: draft.skills.flatMap(value => value.requiredTools),
    knowledgeBaseRefs: draft.skills.flatMap(value => value.knowledgeBaseRefs),
  }
  const markdown = (value: Pick<ExtensionDraft, 'id' | 'summary' | 'body'> & { description?: string | undefined },
    path: string, bundled: boolean): string => {
    const original = originals[path]
    let header = stringify({ name: value.id, description: value.description ?? value.summary })
    if (original !== undefined) {
      const parsed = parseSkillMarkdown(original, bundled)
      const description = value.description
        ?? (bundled && value.summary === parsed.summary ? parsed.description : undefined) ?? value.summary
      if (parsed.id === value.id && (parsed.description ?? parsed.summary) === description && parsed.body === value.body.trim()) {
        return original
      }
      const normalized = original.replace(/\r\n/g, '\n')
      const document = parseDocument(normalized.slice(4, normalized.indexOf('\n---\n', 4)), { uniqueKeys: true })
      document.set('name', value.id)
      document.set('description', description)
      header = document.toString()
    }
    const result = `---\n${header}---\n\n${value.body.trim()}\n`
    const checked = parseSkillMarkdown(result, bundled)
    if (checked.summary !== value.summary && checked.description !== value.summary) throw new Error('Skill summary differs from its native description')
    return result
  }
  const readme = draft.kind === 'skill' ? markdown(draft, 'SKILL.md', false) : `${draft.body.trim()}\n`
  const common = { id: draft.id, name: draft.name, version: draft.version, summary: draft.summary,
    ...(draft.author ? { author: draft.author } : {}), category: draft.category, triggers: draft.triggers,
    minimumDesktopVersion: draft.minimumDesktopVersion, connectorRefs: unique(refs.connectorRefs),
    requiredTools: unique(refs.requiredTools), knowledgeBaseRefs: unique(refs.knowledgeBaseRefs) }
  const files: Record<string, string> = {}
  const skills = draft.skills.map((value) => {
    const path = `skills/${value.id}/SKILL.md`
    files[path] = markdown(value, path, true)
    return { id: value.id, name: value.name, summary: value.summary, triggers: value.triggers, path,
      ...(value.source ? { source: value.source } : {}), connectorRefs: unique(value.connectorRefs),
      requiredTools: unique(value.requiredTools), knowledgeBaseRefs: unique(value.knowledgeBaseRefs) }
  })
  files[draft.kind === 'skill' ? 'SKILL.md' : 'README.md'] = readme
  files[draft.kind === 'skill' ? '.deepseek-harness-skill/skill.json' : '.deepseek-harness-kit/kit.json'] =
    JSON.stringify(draft.kind === 'skill' ? { schemaVersion: '1', ...common, allowImplicitInvocation: true }
      : { schemaVersion: '3', ...common, skills, commonTasks: draft.commonTasks }, null, 2) + '\n'
  return { files, release: { kind: draft.kind, ...common, readme, commonTasks: draft.kind === 'skill' ? [] : draft.commonTasks,
    skillIds: draft.kind === 'skill' ? [draft.id] : skills.map(value => value.id),
    skillDetails: draft.kind === 'skill' ? [{ id: draft.id, name: draft.name, summary: draft.summary }]
      : draft.skills.map(value => ({ id: value.id, name: value.name, summary: value.summary })) } }
}
