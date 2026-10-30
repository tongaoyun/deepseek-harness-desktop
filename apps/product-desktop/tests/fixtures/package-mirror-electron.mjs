/** Real Electron mirror transfers with inert payloads; no installer or persistent application state. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { createRequire } from 'node:module'
import { DesktopUpdateHttpExecutor } from '../../../desktop/lib/types/update-http-executor.js'
import { DesktopUpdateMirrorProvider } from '../../../desktop/lib/types/update-mirror-provider.js'

const require = createRequire(new URL('../../../desktop/package.json', import.meta.url))
const updater = require('electron-updater')
const { getNetSession } = require('electron-updater/out/electronHttpExecutor.js')

async function main() {
  const root = process.env.DSH_PACKAGE_MIRROR_TEST_ROOT
  assert.ok(root, 'The launcher must own the private user-data directory')
  app.setPath('userData', join(root, 'electron'))
  await app.whenReady()
  const payload = Buffer.from('inert updater transport fixture\n')
  const hash = createHash('sha512').update(payload).digest('base64')
  const source = new URL('https://github.com/example/downloads/releases/download/v1.2.3-alpha.1/desktop-x64.zip')
  let mode = 'healthy'
  let primaryRequests = 0
  let fallbackRequests = 0
  let cancelActive
  const server = createServer((request, response) => {
    if (request.url === '/fallback') { fallbackRequests++; response.end(payload); return }
    primaryRequests++
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
    if (mode === 'range') {
      assert.equal(request.headers.range, 'bytes=0-3')
      response.writeHead(206, { 'Content-Range': `bytes 0-3/${payload.length}` }).end(payload.subarray(0, 4)); return
    }
    if (mode === 'unauthorized') { response.writeHead(401).end(); return }
    if (mode === 'unavailable') { response.writeHead(503).end(); return }
    if (mode === 'cancelled') { cancelActive(); return }
    if (mode === 'timeout') return
    response.end(mode === 'corrupt' ? Buffer.from('corrupt') : payload)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const mirror = { packageUrl: `${origin}/api/packages/company/generic/desktop/`, githubRepository: 'example/downloads' }
  const transport = new DesktopUpdateHttpExecutor(1000, undefined, mirror)
  const session = getNetSession()
  session.webRequest.onBeforeRequest({ urls: [source.href] }, (_details, callback) => callback({ redirectURL: `${origin}/fallback` }))
  const cases = []
  try {
    const provider = new DesktopUpdateMirrorProvider({ provider: 'custom', mirror, channel: 'nightly' },
      { channel: 'nightly' }, { executor: transport, platform: 'darwin' })
    const [file] = provider.resolveFiles({ version: '1.2.3-alpha.1', releaseDate: new Date().toISOString(),
      files: [{ url: source.href, sha512: hash, size: payload.length }] })
    assert.equal(file.url.href, `${mirror.packageUrl}1.2.3-alpha.1/desktop-x64.zip`)
    assert.equal(file.info.sha512, hash)
    cases.push('native-provider-keeps-version-and-digest')
    for (const scenario of ['healthy', 'unavailable', 'timeout', 'corrupt', 'unauthorized', 'cancelled']) {
      mode = scenario
      primaryRequests = 0; fallbackRequests = 0
      const destination = join(root, `${scenario}.zip`)
      const cancellationToken = new updater.CancellationToken()
      cancelActive = () => cancellationToken.cancel()
      const operation = transport.download(file.url, destination, { cancellationToken, sha512: hash,
        headers: { Authorization: 'fixture-private', Cookie: 'fixture-private' } })
      if (scenario === 'corrupt' || scenario === 'unauthorized' || scenario === 'cancelled') {
        await assert.rejects(operation, error => scenario === 'corrupt' ? error.code === 'ERR_CHECKSUM_MISMATCH'
          : scenario === 'unauthorized' ? error.statusCode === 401 : cancellationToken.cancelled && error instanceof Error)
        assert.equal(fallbackRequests, 0)
      } else {
        await operation
        assert.deepEqual(await readFile(destination), payload)
        assert.equal(fallbackRequests, scenario === 'healthy' ? 0 : 1)
      }
      assert.equal(primaryRequests, 1)
      cases.push(scenario)
    }
    mode = 'range'
    await new Promise((resolve, reject) => {
      const url = new URL(file.url)
      const request = transport.createRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname,
        headers: { Range: 'bytes=0-3', Authorization: 'fixture-private', Cookie: 'fixture-private' } }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('end', () => {
          try { assert.deepEqual(Buffer.concat(chunks), payload.subarray(0, 4)); resolve() } catch (error) { reject(error) }
        })
        response.once('error', reject)
      })
      transport.addErrorAndTimeoutHandlers(request, reject)
      request.end()
    })
    cases.push('credential-free-differential-range')
    console.log(JSON.stringify({ cases, inertPayload: true, installationAttempted: false }))
  } finally {
    session.webRequest.onBeforeRequest(null)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    app.quit()
  }
}
main().catch(error => { console.error(error); app.exit(1) })
