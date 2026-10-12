import { expect, it } from 'vitest'
import { EXTENSION_CATEGORIES, ExtensionDraftSchema, extensionFiles, parseSkillMarkdown } from '../src/authoring.ts'
import { skillCatalogSummary } from '../src/extension-draft.ts'

const skill = { kind: 'skill', id: 'policy-review', version: '1.0.0', name: 'Policy review', summary: 'Review policy evidence.',
  category: 'legal', body: 'Read policy evidence before answering.', triggers: ['Review policy'] } as const

it('preserves long native discovery text, two-character bundled IDs and original frontmatter through edits', () => {
  const description = `Review policy evidence. ${'Use for detailed review. '.repeat(30)}`.trim()
  const original = `---\nname: qa\ndescription: >\n  ${description}\nargument-hint: document\nchain:\n  next: brief\n---\n\n${'Evidence '.repeat(10_000)}\n`
  const parsed = parseSkillMarkdown(original, true)
  expect(parsed).toMatchObject({ id: 'qa', summary: skill.summary })
  expect(parsed.description?.trim()).toBe(description)
  const bundled = { ...skill, ...parsed, importedId: 'qa' }
  const draft = ExtensionDraftSchema.parse({ ...skill, kind: 'expert-kit', id: 'policy-kit', skills: [bundled] })
  const path = 'skills/qa/SKILL.md'
  expect(extensionFiles(draft, { [path]: original }).files[path]).toBe(original)
  const changed = extensionFiles({ ...draft, skills: [{ ...draft.skills[0]!, id: 'quality', body: 'Updated instructions.' }] },
    { 'skills/quality/SKILL.md': original }).files['skills/quality/SKILL.md']!
  expect(changed).toContain('argument-hint: document')
  expect(changed).toContain('next: brief')
  expect(parseSkillMarkdown(changed, true)).toMatchObject({ id: 'quality', body: 'Updated instructions.', description: parsed.description })
  const { description: _description, ...withoutDescription } = draft.skills[0]!
  const retained = extensionFiles({ ...draft, skills: [{ ...withoutDescription, body: 'Updated instructions.' }] }, { [path]: original }).files[path]!
  expect(parseSkillMarkdown(retained, true).description).toBe(parsed.description)
  const revisedDescription = `Updated discovery. ${'Detailed trigger rules. '.repeat(20)}`.trim()
  const revised = extensionFiles({ ...draft, skills: [{ ...draft.skills[0]!, description: revisedDescription,
    summary: skillCatalogSummary(revisedDescription) }] }, { [path]: original }).files[path]!
  expect(parseSkillMarkdown(revised, true)).toMatchObject({ description: revisedDescription, summary: 'Updated discovery.' })
  expect(revised).toContain('next: brief')
  expect(() => parseSkillMarkdown(original)).toThrow()
})

it.each([{ bundled: false, bytes: 65_536 }, { bundled: true, bytes: 262_144 }])('bounds the complete $bytes-byte native file', ({ bundled, bytes }) => {
  const prefix = '---\nname: policy-review\ndescription: Review policy evidence.\n---\n\n'
  const markdown = prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix))
  expect(() => parseSkillMarkdown(markdown, bundled)).not.toThrow()
  expect(() => parseSkillMarkdown(markdown + 'x', bundled)).toThrow('frontmatter')
})

it('checks complete generated Markdown byte limits and native description summaries', () => {
  expect(skillCatalogSummary('  First sentence.\n' + 'Long text '.repeat(40))).toBe('First sentence.')
  expect(skillCatalogSummary('x'.repeat(301))).toBe('x'.repeat(299) + '…')
  expect(skillCatalogSummary('x'.repeat(300))).toHaveLength(300)
  const kit = { ...skill, kind: 'expert-kit', skills: [{ ...skill, body: 'x'.repeat(262_140) }] }
  expect(() => extensionFiles(ExtensionDraftSchema.parse(kit))).toThrow('frontmatter')
  expect(ExtensionDraftSchema.safeParse({ ...kit, skills: [{ ...skill, body: '文'.repeat(100_000) }] }).success).toBe(false)
  expect(ExtensionDraftSchema.safeParse({ ...kit, skills: [{ ...skill, description: 'Different discovery text.' }] }).success).toBe(false)
  expect(() => extensionFiles(ExtensionDraftSchema.parse({ ...skill, body: '文'.repeat(25_000) }))).toThrow('frontmatter')
})

it('generates a discoverable standard skill and complete release coordinates', () => {
  const generated = extensionFiles(ExtensionDraftSchema.parse(skill))
  expect(parseSkillMarkdown(generated.files['SKILL.md']!)).toEqual({ id: skill.id, summary: skill.summary, body: skill.body })
  expect(generated.release).toMatchObject({ skillIds: [skill.id],
    skillDetails: [{ id: skill.id, name: skill.name, summary: skill.summary }] })
  expect(JSON.parse(generated.files['.deepseek-harness-skill/skill.json']!)).toMatchObject({ schemaVersion: '1', allowImplicitInvocation: true })
  expect(EXTENSION_CATEGORIES).toHaveLength(20)
  expect(new Set(EXTENSION_CATEGORIES).size).toBe(20)
})

it('pins copied skill source identities and calculates a sorted dependency union', () => {
  const source = { id: skill.id, version: '1.0.0', sha256: 'a'.repeat(64) }
  const generated = extensionFiles(ExtensionDraftSchema.parse({ ...skill, kind: 'expert-kit', id: 'policy-kit',
    connectorRefs: ['ignored-parent'], skills: [
      { ...skill, source, connectorRefs: ['erp', 'crm'], requiredTools: ['read_policy'], knowledgeBaseRefs: ['organization:policy'] },
      { ...skill, id: 'policy-summary', connectorRefs: ['erp'], requiredTools: ['read_policy'], knowledgeBaseRefs: [] },
    ] }))
  expect(generated.release).toMatchObject({ connectorRefs: ['crm', 'erp'], requiredTools: ['read_policy'], knowledgeBaseRefs: ['organization:policy'] })
  expect(JSON.parse(generated.files['.deepseek-harness-kit/kit.json']!)).toMatchObject({ skills: [{ name: skill.name, source }, {}] })
})

it('rejects unsupported categories, empty kits, owner forgery, malformed YAML and OAuth secret mixing', () => {
  expect(ExtensionDraftSchema.safeParse({ ...skill, category: 'unknown' }).success).toBe(false)
  expect(ExtensionDraftSchema.safeParse({ ...skill, kind: 'expert-kit' }).success).toBe(false)
  expect(ExtensionDraftSchema.safeParse({ ...skill, commonTasks: [{ id: 'review-policy', name: 'Review', description: 'Review policy', prompt: 'Review this policy' }] }).success).toBe(false)
  expect(ExtensionDraftSchema.safeParse({ ...skill, skills: [skill] }).success).toBe(false)
  expect(ExtensionDraftSchema.safeParse({ ...skill, ownerEmployeeId: 'someone-else' }).success).toBe(false)
  expect(ExtensionDraftSchema.safeParse({ ...skill, kind: 'connector', transport: 'streamable-http', oauthProviderId: 'existing-oauth', headers: { secret: 'private' } }).success).toBe(false)
  expect(() => parseSkillMarkdown('---\nname: first\nname: second\ndescription: Test\n---\nBody')).toThrow()
  expect(() => parseSkillMarkdown('---\nname: skill-test\ndescription: !exec run\n---\nBody')).toThrow()
})

it('requires explicit shortcut bindings and preserves them in the release and artifact', () => {
  const kit = { ...skill, kind: 'expert-kit', id: 'policy-kit', skills: [skill],
    commonTasks: [{ id: 'review-policy', name: 'Review', description: 'Review policy', prompt: 'Review this policy', skillIds: [skill.id] }] }
  const generated = extensionFiles(ExtensionDraftSchema.parse(kit))
  expect(generated.release).toMatchObject({ commonTasks: kit.commonTasks })
  expect(JSON.parse(generated.files['.deepseek-harness-kit/kit.json']!)).toMatchObject({ commonTasks: kit.commonTasks })
  for (const skillIds of [undefined, [], ['missing'], [skill.id, skill.id]]) {
    expect(ExtensionDraftSchema.safeParse({ ...kit, commonTasks: [{ ...kit.commonTasks[0], skillIds }] }).success).toBe(false)
  }
})
