import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { collectDesktopRelease, extractBuildArchive, publishDesktopRelease, RELEASE_TARGETS, waitForDesktopBuild } from '../scripts/desktop-release.mjs'
import { apiClient, releaseDestination } from '../scripts/deliver-desktop.mjs'

const commit = 'a'.repeat(40)
const version = '0.2.1-alpha.2.20261012.9.1'
const productVersion = '0.2.1-alpha.2'
const hash = value => createHash('sha256').update(value).digest('hex')
const run = { id: 99, head_sha: commit, status: 'completed', conclusion: 'success', run_number: 9,
  run_attempt: 1, created_at: '2026-10-12T23:59:00Z', event: 'workflow_dispatch', path: '.github/workflows/product-desktop-package.yml' }

test('Gitea HTTP adapter streams multipart attachments and verifies relative authenticated downloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-release-http-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('synthetic installer bytes')
  const path = join(directory, 'Harness.exe')
  await writeFile(path, bytes)
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) })
    if (request.url === '/download') {
      response.writeHead(302, { location: '/blob' }).end()
    } else if (request.url === '/blob') response.end(bytes)
    else response.end(JSON.stringify({ id: 7, name: 'Harness.exe', size: bytes.length }))
  })
  server.listen(0, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const client = apiClient(base, 'token synthetic-credential')
  const destination = releaseDestination('test', client, 'owner/repo', { base, target: commit })
  const asset = await destination.upload(3, { path, name: 'Harness.exe', size: bytes.length })
  const upload = requests[0]
  assert.equal(upload.url, '/repos/owner/repo/releases/3/assets')
  assert.equal(upload.headers.authorization, 'token synthetic-credential')
  const boundary = upload.headers['content-type'].split('boundary=')[1]
  assert.equal(Number(upload.headers['content-length']), upload.body.length)
  assert.deepEqual(upload.body, Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="Harness.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]))
  assert.equal(await destination.hash({ ...asset, browser_download_url: `${base}/download` }), hash(bytes))
  assert.equal(requests.at(-1).headers.authorization, 'token synthetic-credential')
  assert.throws(() => client.response('https://other.invalid/blob', {}), /forward credentials/u)
})

async function staged(t) {
  const folder = await mkdtemp(join(tmpdir(), 'harness-release-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  for (const target of RELEASE_TARGETS) {
    const directory = join(folder, target)
    await mkdir(directory)
    const name = `Harness-${target}.${target === 'win-x64' ? 'exe' : 'dmg'}`
    const bytes = Buffer.from(`synthetic ${target} installer`)
    await writeFile(join(directory, name), bytes)
    await writeFile(join(directory, 'build-manifest.json'), JSON.stringify({ target, commit, version, signing: 'unsigned',
      artifacts: [{ name, size: bytes.length, sha256: hash(bytes) }] }))
  }
  return folder
}

test('aggregates all platforms and writes matching source, version and checksums', async t => {
  const directory = await staged(t)
  const release = await collectDesktopRelease(directory, run, commit, productVersion)
  assert.equal(release.tag, `v${version}`)
  assert.equal(release.files.length, 5)
  const manifest = JSON.parse(await readFile(join(directory, 'build-manifest.json'), 'utf8'))
  assert.equal(manifest.commit, commit)
  assert.deepEqual(manifest.targets.map(row => row.target), RELEASE_TARGETS)
  assert.equal((await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 3)
})

test('refuses failed or cancelled builds and another source before opening files', async () => {
  for (const invalid of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress' }, { head_sha: 'b'.repeat(40) }]) {
    await assert.rejects(collectDesktopRelease('/does-not-exist', { ...run, ...invalid }, commit, productVersion), /successful build/u)
  }
})

test('rejects missing platforms, source/attempt/version mismatches and unexpected files', async t => {
  for (const kind of ['missing', 'source', 'attempt', 'version', 'extra', 'duplicate', 'path']) {
    const directory = await staged(t)
    const path = join(directory, 'mac-x64', 'build-manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (kind === 'missing') await rm(join(directory, 'mac-x64'), { recursive: true })
    else if (kind === 'extra') await writeFile(join(directory, 'mac-x64', '.env'), 'private')
    else {
      if (kind === 'source') manifest.commit = 'b'.repeat(40)
      if (kind === 'attempt') manifest.version = version.replace(/\.1$/u, '.2')
      if (kind === 'version') manifest.version = version.replace('0.2.1', '9.0.0')
      if (kind === 'duplicate') manifest.artifacts.push(manifest.artifacts[0])
      if (kind === 'path') manifest.artifacts[0].name = '../file.dmg'
      await writeFile(path, JSON.stringify(manifest))
    }
    await assert.rejects(collectDesktopRelease(directory, run, commit, productVersion), kind)
  }
})

test('detects changed installer bytes before creating release metadata', async t => {
  const directory = await staged(t)
  await writeFile(join(directory, 'win-x64', 'Harness-win-x64.exe'), 'tampered')
  await assert.rejects(collectDesktopRelease(directory, run, commit, productVersion), /checksum/u)
  assert.equal((await readdir(directory)).includes('SHA256SUMS.txt'), false)
})

test('extracts chunked ZIPs and rejects paths, duplicate output and oversized manifests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-release-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const encoder = new TextEncoder()
  const bytes = zipSync({ 'build-manifest.json': encoder.encode('{}'), 'Harness.dmg': encoder.encode('installer') })
  async function* chunks(input) { for (let i = 0; i < input.length; i += 11) yield input.subarray(i, i + 11) }
  await extractBuildArchive(chunks(bytes), join(root, 'good'))
  assert.equal(await readFile(join(root, 'good', 'Harness.dmg'), 'utf8'), 'installer')
  for (const [id, entries] of [['path', { '../escape.dmg': encoder.encode('bad') }],
    ['unknown', { '.env': encoder.encode('private') }], ['large', { 'build-manifest.json': new Uint8Array(65 * 1024) }]]) {
    await assert.rejects(extractBuildArchive(chunks(zipSync(entries)), join(root, id)))
  }
  await assert.rejects(extractBuildArchive(chunks(bytes.subarray(0, 25)), join(root, 'truncated')))
})

test('correlates a new dispatch instead of using another successful build', async () => {
  const calls = []
  let time = 0
  const result = await waitForDesktopBuild({ repository: 'test/build', commit, deliveryId: 'delivery', now: () => time,
    sleep: async ms => { time += ms }, progress: () => {}, request: async (method, path) => {
      calls.push(path)
      if (path.includes('/workflows/')) return { workflow_runs: [
        { ...run, id: 98, display_title: `Desktop ${commit} / another` },
        { ...run, status: 'queued', conclusion: null, display_title: `Desktop ${commit} / delivery` },
      ] }
      return run
    } })
  assert.equal(result.id, 99)
  assert.ok(calls.at(-1).endsWith('/99'))
})

test('rejects ambiguous, cancelled, unauthorized-source and timed-out hosted runs', async () => {
  for (const patch of [{ conclusion: 'cancelled' }, { head_sha: 'b'.repeat(40) }, { event: 'push' }, { path: 'unrelated.yml' }]) {
    await assert.rejects(waitForDesktopBuild({ repository: 'test/build', commit, runId: 99,
      request: async () => ({ ...run, ...patch }), progress: () => {} }))
  }
  await assert.rejects(waitForDesktopBuild({ repository: 'test/build', commit, deliveryId: 'same',
    request: async () => ({ workflow_runs: [1, 2].map(id => ({ ...run, id, display_title: `Desktop ${commit} / same` })) }) }), /Ambiguous/u)
  let time = 0
  await assert.rejects(waitForDesktopBuild({ repository: 'test/build', commit, timeoutMs: 10, pollMs: 4,
    request: async () => ({ workflow_runs: [] }), now: () => time, sleep: async ms => { time += ms } }), /Timed out/u)
})

function destination(name, release, options = {}) {
  const calls = []
  const assets = []
  let remote
  return { name, calls, find: async () => remote, create: async () => {
    calls.push('create')
    remote = { id: 1, tag_name: release.tag, body: release.body, prerelease: true, draft: true, html_url: `https://${name}/release` }
    return remote
  }, assets: async () => [...assets], upload: async (id, file) => {
    calls.push(`upload ${file.name}`)
    const asset = { ...file, id: assets.length + 1 }
    assets.push(asset)
    if (options.uploadLost && calls.filter(value => value.startsWith('upload')).length === 1) throw new Error('Response lost')
    return asset
  }, hash: async asset => options.badHash ? 'bad' : asset.sha256, finalize: async () => {
    calls.push('finalize')
    if (options.finalizeFails) throw new Error('Finalize failed')
    remote.draft = false
  } }
}

const release = { tag: `v${version}`, version, commit, body: 'synthetic release identity', files: [
  { name: 'Harness.exe', size: 10, sha256: 'a'.repeat(64) }, { name: 'build-manifest.json', size: 20, sha256: 'b'.repeat(64) },
] }

test('stages both destinations, reconciles interrupted uploads and repeats without uploading', async () => {
  const internal = destination('gitea', release, { uploadLost: true })
  const publicRepo = destination('github', release)
  assert.deepEqual(await publishDesktopRelease(release, [internal, publicRepo]), ['https://gitea/release', 'https://github/release'])
  assert.equal(internal.calls.filter(value => value.startsWith('upload')).length, 2)
  const before = JSON.stringify([internal.calls, publicRepo.calls])
  await publishDesktopRelease(release, [internal, publicRepo])
  assert.equal(JSON.stringify([internal.calls, publicRepo.calls]), before)
})

test('does not finalize either destination when a remote checksum differs', async () => {
  const internal = destination('gitea', release)
  const publicRepo = destination('github', release, { badHash: true })
  await assert.rejects(publishDesktopRelease(release, [internal, publicRepo]), /checksum/u)
  assert.equal(internal.calls.includes('finalize'), false)
  assert.equal(publicRepo.calls.includes('finalize'), false)
})

test('rejects conflicting release identities and unknown assets without deletion or overwrite', async () => {
  for (const remote of [{ tag_name: release.tag, body: 'another source', prerelease: true },
    { tag_name: release.tag, body: release.body, prerelease: false }]) {
    await assert.rejects(publishDesktopRelease(release, [{ name: 'github', find: async () => remote }]), /identity/u)
  }
  const target = destination('github', release)
  await target.create()
  target.assets = async () => [{ name: '.env', size: 5 }]
  await assert.rejects(publishDesktopRelease(release, [target]), /Unexpected/u)
  assert.deepEqual(target.calls, ['create'])
})

test('resumes partial finalization without reuploading or replacing either destination', async () => {
  const internal = destination('gitea', release)
  const publicRepo = destination('github', release, { finalizeFails: true })
  await assert.rejects(publishDesktopRelease(release, [internal, publicRepo]), /Finalize/u)
  assert.equal((await internal.find()).draft, false)
  publicRepo.finalize = async () => { (await publicRepo.find()).draft = false }
  const count = internal.calls.length + publicRepo.calls.length
  await publishDesktopRelease(release, [internal, publicRepo])
  assert.equal(internal.calls.length + publicRepo.calls.length, count)
})
