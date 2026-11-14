/** Reject desktop UI reports that ran no required acceptance scenario. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Verify that every required desktop carrier actually passed, with no failed tests.
 * @param {string} path Vitest JSON report path.
 * @param {'built' | 'installed'} carrier Required desktop assembly.
 * @returns {Promise<void>} Rejects missing, malformed, failed or skipped required scenarios.
 */
export async function verifyUiAcceptance(path, carrier) {
  if (!['built', 'installed'].includes(carrier)) throw new Error('Use built or installed desktop acceptance')
  const report = JSON.parse(await readFile(path, 'utf8'))
  const expected = carrier === 'built' ? ['official', 'product'] : ['product']
  const assertions = report.testResults?.flatMap(result => result.assertionResults)
  if (report.success !== true || report.numFailedTests !== 0 || !Array.isArray(assertions)) {
    throw new Error('Desktop UI acceptance report is invalid or failed')
  }
  for (const mode of expected) {
    const name = `boots the ${carrier} ${mode} Electron assembly with an isolated profile`
    if (!assertions.some(test => test.title === name && test.status === 'passed')) {
      throw new Error(`Desktop UI acceptance did not pass: ${name}`)
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await verifyUiAcceptance(process.argv[2], process.argv[3]).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
