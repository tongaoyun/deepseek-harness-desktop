import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import yaml from 'js-yaml'

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/product-desktop-package.yml', import.meta.url), 'utf8'))
const command = workflow.jobs.package.steps.find(step => step.name === 'Package Windows').run
const available = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 10_000 })
const unavailable = available.error?.code === 'ENOENT'
if (!unavailable) {
  assert.ifError(available.error)
  assert.equal(available.status, 0, available.stderr?.toString())
}

for (const signing of ['signed', 'unsigned']) {
  test(`passes intact ${signing} Windows packaging arguments`, { skip: unavailable ? 'PowerShell is unavailable on this host; the Windows packaging runner executes this regression' : false }, () => {
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      function pnpm {
        & $env:HARNESS_TEST_NODE -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- @args
        $global:LASTEXITCODE = $LASTEXITCODE
      }
      ${command}
    `], { encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HARNESS_TEST_NODE: process.execPath, PACKAGE_SIGNING: signing, PACKAGE_VERSION: '0.2.1-rc.2.20261018.37.1' } })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), ['--dir', 'apps/product-desktop', 'run', 'package', 'win-x64',
      ...signing === 'unsigned' ? ['--unsigned'] : [], '--build-version', '0.2.1-rc.2.20261018.37.1'])
  })
}
