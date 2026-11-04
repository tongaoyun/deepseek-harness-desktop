import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parseSkillDoc, resolveAgentsHome, resolveDshHome, scanEntries } from './core.ts'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { skillCategory, withSkillCategory } from './skill-document.ts'

afterEach(() => { vi.unstubAllEnvs() })

it('exports a category without losing native permissions, unrelated metadata or literal body text', () => {
  const raw = '---\r\nname: docs\r\ndescription: Docs\r\nmetadata:\r\n  category: 文档办公\r\n  author: Example\r\nuser-invocable: false\r\n---\r\n\r\nKeep {{literal}}.\r\n'
  expect(withSkillCategory(raw, '文档办公')).toBe(raw)
  const updated = parseSkillDoc(withSkillCategory(raw, '企业协作'))
  expect(updated.data).toMatchObject({ 'user-invocable': false, metadata: { category: '企业协作', author: 'Example' } })
  expect(updated.body).toBe('\r\nKeep {{literal}}.\r\n')
  expect(parseSkillDoc(withSkillCategory(raw, undefined)).data).toMatchObject({ metadata: { author: 'Example' } })
  expect(skillCategory({ metadata: { category: ['invalid'] } })).toBeUndefined()
  expect(skillCategory({ metadata: { category: 'x'.repeat(25) } })).toBeUndefined()
  expect(skillCategory({ metadata: { category: 'line\nbreak' } })).toBeUndefined()
})

it('uses native home expansion, absolute paths and blank override handling', () => {
  vi.stubEnv('DSH_HOME', '~/harness-native-reuse')
  vi.stubEnv('DSH_AGENTS_HOME', '   ')
  expect(resolveDshHome()).toBe(join(homedir(), 'harness-native-reuse'))
  expect(resolveAgentsHome()).toBe(join(homedir(), '.agents'))
  vi.stubEnv('DSH_HOME', 'relative-harness')
  expect(resolveDshHome()).toBe(resolve('relative-harness'))
})

it('parses YAML comments, escaped strings and folded blocks using the native document rules', () => {
  const parsed = parseSkillDoc('---\nname: audit-orders # catalog name\ndescription: >-\n  Audit orders\n\n  Keep paragraphs\n---\n  Body\r\n')
  expect(parsed.map.name).toBe('audit-orders')
  expect(parsed.map.description).toBe('Audit orders\nKeep paragraphs')
  expect(parsed.body).toBe('  Body\r\n')
})

it.each([
  'name: audit-orders\nname: another-skill\ndescription: Repeated name',
  'name: audit-orders\ndescription: [invalid YAML',
])('keeps malformed YAML unavailable: %s', (header) => {
  expect(parseSkillDoc(`---\n${header}\n---\nBody`).hasFrontmatter).toBe(false)
})

it('refuses native-invalid invocation declarations and names while keeping entries visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-native-policy-'))
  try {
    const headers = [
      ['legacy-model', 'disableModelInvocation: true'],
      ['legacy-user', 'userInvocable: false'],
      ['legacy-positive', 'modelInvocable: false'],
      ['valid-policy', 'disable-model-invocation: true # no model calls\nuser-invocable: false # no user calls'],
      ['bad-policy', 'user-invocable: [false]'],
      ['UpperCase', ''],
    ]
    for (const [name, policy] of headers) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Audit orders\n${policy}\n---\nBody`)
    }
    const { entries } = await scanEntries(root)
    for (const name of ['legacy-model', 'legacy-user', 'legacy-positive', 'bad-policy']) {
      expect(entries.find(entry => entry.name === name)?.invocationPolicyValid, name).toBe(false)
    }
    expect(entries.find(entry => entry.name === 'valid-policy')).toMatchObject({
      invocationPolicyValid: true, modelInvocable: false, userInvocable: false,
    })
    expect(entries.find(entry => entry.name === 'UpperCase')?.loadable).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
