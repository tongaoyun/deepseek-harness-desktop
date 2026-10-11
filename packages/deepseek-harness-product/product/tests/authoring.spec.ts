import { expect, it } from 'vitest'
import { EXTENSION_CATEGORIES, ExtensionDraftSchema, extensionFiles, parseSkillMarkdown } from '../src/authoring.ts'

const skill = { kind: 'skill', id: 'policy-review', version: '1.0.0', name: 'Policy review', summary: 'Review policy evidence.',
  category: 'legal', body: 'Read policy evidence before answering.', triggers: ['Review policy'] } as const

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
  expect(JSON.parse(generated.files['.deepseek-harness-kit/kit.json']!).skills[0]).toMatchObject({ name: skill.name, source })
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
