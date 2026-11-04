import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { teamFixture, expertFiles } from '../../product/tests/content-fixtures.ts'
import { installCompanyIndex } from '../../desktop/src/company-content.ts'
import { readCompanyTeams } from '../src/company-teams.ts'
import { companyContentRelease, contentDigest } from '@deepseek-harness/product/company-content'

it('retains immutable AgentSpec references and binary files for native persona reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-agent-package-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const value = await teamFixture(), signal = new AbortController().signal
  const installed = await installCompanyIndex(root, 'employee', value.index, async ref => ({ ...ref, files: value.payloads.get(ref.sha256) }), signal)
  const catalog = await readCompanyTeams(installed.expertsRoot)
  expect(catalog.experts.size).toBe(2)
  for (const expert of catalog.experts.values()) {
    expect(expert.prompt).toContain('固定成员说明')
    expect(expert.prompt).toContain('expert-versions')
    expect(expert.packageSha256).toHaveLength(64)
  }
  const path = join(installed.expertsRoot, 'member-1/config/SOUL.md')
  expect(await readFile(path, 'utf8')).toContain('固定成员说明')
})
it('rejects invalid AgentSpec descriptions and inconsistent package identifiers', () => {
  for (const manifest of [{ worker: { suggested_name: 'reviewer' }, description: true },
    { worker: { suggested_name: 'wrong' }, description: 'Review' },
    { worker: { suggested_name: 'reviewer' }, description: '' }]) {
    const files = { ...expertFiles('reviewer'), 'experts/reviewer/manifest.json': Buffer.from(JSON.stringify(manifest)).toString('base64') }
    expect(() => companyContentRelease({ version: '1.0.0', sha256: contentDigest(files), files })).toThrow()
  }
})
