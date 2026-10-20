import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectCompanyContent } from '../scripts/publish-company-content.mjs'

test('inspects standard native files without publishing or embedding credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'release.json'), JSON.stringify({ version: '1.0.0' }))
  await mkdir(join(root, 'skills/company-orders'), { recursive: true })
  await writeFile(join(root, 'skills/company-orders/SKILL.md'), '---\nname: company-orders\ndescription: Company orders\n---\nUse the configured tools.')
  const release = await inspectCompanyContent(root)
  assert.equal(release.version, '1.0.0')
  assert.equal(Object.keys(release.files).length, 1)
  assert.match(release.sha256, /^[a-f0-9]{64}$/u)
  await symlink(join(root, 'release.json'), join(root, 'skills/company-orders/private.json'))
  await assert.rejects(inspectCompanyContent(root), /Symbolic links/u)
  await rm(join(root, 'skills/company-orders/private.json'))
  await writeFile(join(root, 'skills/company-orders/SKILL.md'), 'no metadata')
  await assert.rejects(inspectCompanyContent(root))
})
