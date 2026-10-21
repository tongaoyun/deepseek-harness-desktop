import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { exportSkill } from '../../../../vendor/dsh-skills-manager/lib/core.js'

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
