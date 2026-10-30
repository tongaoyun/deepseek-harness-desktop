/** Exercise real Electron HTTP mirror selection without executing an installer. */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcceptanceProcess } from './acceptance-process.mjs'

const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'harness-electron-mirror-'))
try {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
  await runAcceptanceProcess(require('electron'), [fileURLToPath(new URL('../tests/fixtures/package-mirror-electron.mjs', import.meta.url))], {
    timeoutMs: 60_000, env: { ...environment, DSH_PACKAGE_MIRROR_TEST_ROOT: directory },
  })
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
