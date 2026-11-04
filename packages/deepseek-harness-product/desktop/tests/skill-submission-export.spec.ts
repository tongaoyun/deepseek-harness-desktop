import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { exportSkill } from '@deepseek-harness/product-skills/submission'
import { companyContentRelease, contentDigest } from '@deepseek-harness/product/company-content'

let directory = ''
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }) })
it('exports the complete native skill and rejects linked resources and another resource key', async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-company-submit-')); vi.stubEnv('DSH_HOME', directory)
  const skill = join(directory, 'skills/orders'); await mkdir(join(skill, 'references'), { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: orders\ndescription: Review orders\n---\nUse approved tools.')
  await writeFile(join(skill, 'references/policy.md'), 'Policy')
  const result = await exportSkill('dsh', 'orders')
  expect(result.resourceKey).toBe('skills/orders')
  expect(Object.keys(result.files).sort()).toEqual(['skills/orders/SKILL.md', 'skills/orders/references/policy.md'])
  expect(Buffer.from(result.files['skills/orders/references/policy.md']!, 'base64').toString()).toBe('Policy')
  await writeFile(join(directory, 'private'), 'must not upload')
  await symlink(join(directory, 'private'), join(skill, 'private'))
  await expect(exportSkill('dsh', 'orders')).rejects.toThrow('符号链接')
  await expect(exportSkill('company', 'orders')).rejects.toThrow('个人内容')
  await expect(exportSkill('dsh', '../private')).rejects.toThrow()
})

it('exports Chinese reference names, spaces and binary templates as a complete publishable skill', async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-company-submit-')); vi.stubEnv('DSH_HOME', directory)
  const skill = join(directory, 'skills/orders')
  await mkdir(join(skill, 'references'), { recursive: true })
  await mkdir(join(skill, 'assets'))
  const text = '保留 {{literal}}，按资料核对订单。'
  const template = Buffer.from([0x00, 0xff, 0x50, 0x4b, 0x03, 0x04])
  await writeFile(join(skill, 'SKILL.md'), '---\nname: orders\ndescription: Review orders\nmetadata:\n  category: 数据分析\n---\nUse references/中文 资料.md and assets/模板（终版）.bin.')
  await writeFile(join(skill, 'references/中文 资料.md'), text)
  await writeFile(join(skill, 'assets/模板（终版）.bin'), template)
  const { files } = await exportSkill('dsh', 'orders')
  expect(files['skills/orders/references/中文 资料.md']).toBe(Buffer.from(text).toString('base64'))
  expect(files['skills/orders/assets/模板（终版）.bin']).toBe(template.toString('base64'))
  expect(companyContentRelease({ version: '1.0.0', sha256: contentDigest(files), files }).files).toEqual(files)
})

it('rejects an exported skill document beyond the company publication byte limit', async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-company-submit-')); vi.stubEnv('DSH_HOME', directory)
  const skill = join(directory, 'skills/orders'); await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: orders\ndescription: Review orders\n---\n' + '中文'.repeat(24 * 1024))
  await expect(exportSkill('dsh', 'orders')).rejects.toThrow('说明过长')
})

it('counts the skill resource prefix in the publication path limit', async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-company-submit-')); vi.stubEnv('DSH_HOME', directory)
  const skill = join(directory, 'skills/orders')
  const references = 'references/' + 'x'.repeat(100)
  const name = 'y'.repeat(111) + '.md'
  expect(('skills/orders/' + references + '/' + name).length).toBe(240)
  await mkdir(join(skill, references), { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: orders\ndescription: Review orders\n---\nUse approved tools.')
  await writeFile(join(skill, references, name), 'Exact path limit')
  expect(Object.keys((await exportSkill('dsh', 'orders')).files)).toHaveLength(2)
  await writeFile(join(skill, references, 'z' + name), 'Over the path limit')
  await expect(exportSkill('dsh', 'orders')).rejects.toThrow('非法资源路径')
})
