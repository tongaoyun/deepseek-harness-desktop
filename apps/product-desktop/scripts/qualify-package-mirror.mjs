/** Exercise real Electron HTTP mirror selection without executing an installer. */
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAcceptanceProcess } from './acceptance-process.mjs'
import { nativeUpdateFeedBootstrap } from '../tests/native-update-feed-bootstrap.mjs'

const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'harness-electron-mirror-'))
let feedRequested = false
const feed = createServer((request, response) => {
  assert.equal(request.headers.authorization, undefined)
  assert.equal(request.headers.cookie, undefined)
  if (request.url === '/github/releases/latest') {
    response.end(JSON.stringify({ tag_name: 'v1.2.3-alpha.1', draft: false,
      assets: ['nightly.yml', 'nightly-mac.yml'].map((name, index) => ({ name,
        url: `https://api.github.com/repos/example/downloads/releases/assets/${index + 1}` })) })); return
  }
  if (/^\/github\/releases\/assets\/[12]$/u.test(request.url)) {
    const payload = Buffer.from('inert updater transport fixture\n')
    response.end(JSON.stringify({ version: '1.2.3-alpha.1', releaseDate: '2026-10-31T00:00:00.000Z', files: [{
      url: 'https://github.com/example/downloads/releases/download/v1.2.3-alpha.1/desktop-x64.zip',
      sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length,
    }] })); return
  }
  assert.equal(request.url, '/nightly.yml')
  feedRequested = true
  response.end('fixture update feed')
})
try {
  await new Promise((resolve, reject) => { feed.once('error', reject); feed.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${feed.address().port}/`
  const entry = join(directory, 'qualification.mjs')
  await writeFile(entry, `import { app, session } from 'electron'\n${nativeUpdateFeedBootstrap({ githubRepository: 'example/downloads', origin })}
await import(${JSON.stringify(new URL('../tests/fixtures/package-mirror-electron.mjs', import.meta.url).href)})\n`)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
  await runAcceptanceProcess(require('electron'), [entry], {
    timeoutMs: 60_000, env: { ...environment, DSH_PACKAGE_MIRROR_TEST_ROOT: directory },
  })
  assert.ok(feedRequested, 'The native qualification entry must map the feed before the imported main requests it')
} finally {
  feed.closeAllConnections()
  await new Promise((resolve, reject) => feed.close(error => { if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve() }))
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
