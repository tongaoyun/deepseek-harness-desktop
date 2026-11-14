import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { verifyUiAcceptance } from '../scripts/verify-ui-acceptance.mjs'

for (const carrier of ['built', 'installed']) {
  test(`${carrier} acceptance requires every expected scenario to pass`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-ui-report-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'report.json')
    await assert.rejects(verifyUiAcceptance(path, carrier), { code: 'ENOENT' })
    const assertions = (carrier === 'built' ? ['official', 'product'] : ['product']).map(mode => ({
      title: `boots the ${carrier} ${mode} Electron assembly with an isolated profile`, status: 'passed',
    }))
    const write = report => writeFile(path, JSON.stringify(report))
    for (const status of ['pending', 'skipped', 'failed']) {
      await write({ success: true, numFailedTests: 0, testResults: [{ assertionResults: assertions.map(test => ({ ...test, status })) }] })
      await assert.rejects(verifyUiAcceptance(path, carrier), /did not pass/u)
    }
    await write({ success: true, numFailedTests: 0, testResults: [] })
    await assert.rejects(verifyUiAcceptance(path, carrier), /did not pass/u)
    await write({ success: true, numFailedTests: 0, testResults: [{ assertionResults: assertions }] })
    await verifyUiAcceptance(path, carrier)
    await write({ success: false, numFailedTests: 1, testResults: [{ assertionResults: assertions }] })
    await assert.rejects(verifyUiAcceptance(path, carrier), /invalid or failed/u)
    await writeFile(path, '{')
    await assert.rejects(verifyUiAcceptance(path, carrier), SyntaxError)
  })
}
