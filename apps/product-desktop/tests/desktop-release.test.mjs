import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Zip, ZipPassThrough, zipSync } from 'fflate'
import { collectDesktopRelease, desktopPackageAttempts, extractBuildArchive, mapReleaseWork, publishDesktopRelease, RELEASE_TARGETS, stageDesktopRelease, waitForDesktopBuild } from '../scripts/desktop-release.mjs'
import { apiClient, downloadDesktopRelease, releaseDestination, stageBuildArchive } from '../scripts/deliver-desktop.mjs'

const commit = 'a'.repeat(40)
const version = '0.2.1-alpha.2.20261012.9.1'
const productVersion = '0.2.1-alpha.2'
const hash = value => createHash('sha256').update(value).digest('hex')
const run = { id: 99, head_sha: commit, status: 'completed', conclusion: 'success', run_number: 9,
  run_attempt: 1, created_at: '2026-10-12T23:59:00Z', event: 'workflow_dispatch', path: '.github/workflows/product-desktop-package.yml' }

const socketFailure = () => new TypeError('fetch failed', {
  cause: Object.assign(new Error('synthetic credential and signed URL must remain private'), { code: 'ECONNRESET' }),
})

test('bounds transfers and waits for active work to settle after failure without scheduling more', async () => {
  const first = Promise.withResolvers()
  const sibling = Promise.withResolvers()
  const active = Promise.withResolvers()
  const calls = []
  let ended = false
  const operation = mapReleaseWork([0, 1, 2, 3], async item => {
    calls.push(item)
    if (calls.length === 2) active.resolve()
    if (item === 0) { await first.promise; throw new Error('transfer failed') }
    await sibling.promise
    return item
  }, 2)
  const checked = assert.rejects(operation, /transfer failed/u).then(() => { ended = true })
  try {
    await active.promise
    first.resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ended, false)
    assert.deepEqual(calls, [0, 1])
  } finally {
    first.resolve()
    sibling.resolve()
    await checked
  }
  assert.deepEqual(await mapReleaseWork([1, 2, 3, 4], async value => value * 2, 2), [2, 4, 6, 8])
})

const packageJob = (target, attempt = 1, patch = {}) => ({ name: target === 'preflight' ? target : `${target} unsigned`,
  run_attempt: attempt, run_id: run.id, head_sha: commit, status: 'completed', conclusion: 'success', ...patch })

test('reuses earlier successful platforms while selecting the latest execution and checking preflight', async () => {
  const latest = { ...run, run_attempt: 2 }
  const request = async (_method, path) => ({ jobs: path.includes('/attempts/2/')
    ? [packageJob('mac-x64', 2)] : ['preflight', ...RELEASE_TARGETS].map(target => packageJob(target)) })
  assert.deepEqual(await desktopPackageAttempts(request, 'owner/build', latest, 'unsigned'), {
    'win-x64': 1, 'mac-arm64': 1, 'mac-x64': 2,
  })
  for (const patch of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { status: 'in_progress' }, { head_sha: 'b'.repeat(40) }, { run_id: 100 }, { run_attempt: 1 }]) {
    await assert.rejects(desktopPackageAttempts(async (_method, path) => ({ jobs: path.includes('/attempts/2/')
      ? [packageJob('mac-x64', 2, patch)] : ['preflight', ...RELEASE_TARGETS].map(target => packageJob(target)) }),
    'owner/build', latest, 'unsigned'), /not successful/u)
  }
  await assert.rejects(desktopPackageAttempts(async () => ({ jobs: RELEASE_TARGETS.map(target => packageJob(target)) }),
    'owner/build', run, 'unsigned'), /Missing/u)
  await assert.rejects(desktopPackageAttempts(request, 'owner/build', { ...latest, path: 'other.yml' }, 'unsigned'), /identity/u)
})

test('verifies hosted packages before accepting an in-progress staging run and rejects expired or duplicate archives', async t => {
  const original = await staged(t)
  const directory = await mkdtemp(join(tmpdir(), 'harness-hosted-download-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifacts = RELEASE_TARGETS.map((target, index) => ({ id: index + 1, expired: false,
    name: `harness-${target}-unsigned-9-1`, workflow_run: { id: run.id, head_sha: commit } }))
  const client = {
    request: async (_method, path) => path.includes('/jobs?')
      ? { jobs: ['preflight', ...RELEASE_TARGETS].map(target => packageJob(target)) } : { artifacts },
    download: async path => {
      const index = Number(/artifacts\/(\d+)/u.exec(path)[1]) - 1
      const target = RELEASE_TARGETS[index]
      const entries = {}
      for (const name of await readdir(join(original, target))) entries[name] = await readFile(join(original, target, name))
      return (async function* () { yield zipSync(entries) })()
    },
  }
  const release = await downloadDesktopRelease(client, 'owner/build', { ...run, status: 'in_progress', conclusion: null },
    directory, commit, productVersion, { signing: 'unsigned' })
  assert.equal(release.version, version)
  for (const kind of ['expired', 'duplicate', 'wrong-source']) {
    const copy = structuredClone(artifacts)
    if (kind === 'expired') copy[0].expired = true
    if (kind === 'duplicate') copy.push(copy[0])
    if (kind === 'wrong-source') copy[0].workflow_run.head_sha = 'b'.repeat(40)
    await assert.rejects(downloadDesktopRelease({ ...client,
      request: async (method, path) => path.includes('/artifacts?') ? { artifacts: copy } : client.request(method, path),
      download: async () => assert.fail('Invalid identities must fail before downloads'),
    }, 'owner/build', run, '/unused', commit, productVersion, { signing: 'unsigned' }), /artifact/u)
  }
})

test('staging leaves drafts private and published retries do not change aggregate identity', async t => {
  const first = await staged(t)
  const second = await staged(t)
  const packageAttempts = Object.fromEntries(RELEASE_TARGETS.map(target => [target, 1]))
  const one = await collectDesktopRelease(first, run, commit, productVersion, { packageAttempts })
  const two = await collectDesktopRelease(second, { ...run, run_attempt: 3 }, commit, productVersion, { packageAttempts })
  assert.equal(one.body, two.body)
  assert.deepEqual(one.files.map(({ name, sha256 }) => [name, sha256]), two.files.map(({ name, sha256 }) => [name, sha256]))
  const adapter = destination('hosted', one)
  await stageDesktopRelease(one, [adapter])
  assert.equal((await adapter.find()).draft, true)
  assert.equal(adapter.calls.includes('finalize'), false)
})

test('the internal publisher requires existing hosted assets with matching provider SHA-256 without reuploading', async () => {
  for (const kind of ['matching', 'missing-release', 'missing-asset', 'digest-missing', 'digest-wrong', 'starter', 'size']) {
    let draft = true
    let finalized = false
    const file = release.files[0]
    const asset = { id: 7, name: file.name, size: kind === 'size' ? 1 : file.size,
      state: kind === 'starter' ? 'starter' : 'uploaded',
      digest: kind === 'digest-missing' ? null : `sha256:${kind === 'digest-wrong' ? 'c'.repeat(64) : file.sha256}` }
    const client = { request: async (method, path) => {
      if (method === 'PATCH') { finalized = true; draft = false; return {} }
      assert.equal(method, 'GET', 'Internal verification must never create, upload or delete hosted assets')
      if (path.includes('/assets?')) return kind === 'missing-asset' ? [] : [asset]
      return kind === 'missing-release' ? undefined : { id: 1, tag_name: release.tag, body: release.body, draft,
        prerelease: true, html_url: 'https://hosted/release' }
    }, download: async () => assert.fail('Do not download verified hosted bytes through the internal publisher') }
    const adapter = releaseDestination('hosted', client, 'owner/downloads', { github: true, staged: true, target: 'main' })
    const operation = publishDesktopRelease({ ...release, files: [file] }, [adapter])
    if (kind === 'matching') assert.deepEqual(await operation, ['https://hosted/release'])
    else await assert.rejects(operation)
    assert.equal(finalized, kind === 'matching')
  }
})

test('hosted staging compares the provider digest with fully downloaded bytes', async () => {
  for (const digest of [undefined, `sha256:${'a'.repeat(64)}`, `sha256:${hash('installer')}`]) {
    let reads = 0
    const adapter = releaseDestination('hosted', { download: async () => {
      reads++
      return (async function* () { yield Buffer.from('installer') })()
    } }, 'owner/downloads', { github: true, target: 'main' })
    const operation = adapter.hash({ id: 7, name: 'test.exe', size: 9, digest })
    if (digest === `sha256:${hash('installer')}`) assert.equal(await operation, hash('installer'))
    else await assert.rejects(operation)
    assert.equal(reads, digest === undefined ? 0 : 1)
  }
})

test('uses the Actions API media type for artifact ZIP redirects and binary media type for release assets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-release-media-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const zip = zipSync({ 'build-manifest.json': Buffer.from('{}'), 'Harness.exe': Buffer.from('installer') })
  const requests = []
  const client = apiClient('https://api.github.com', 'Bearer synthetic-credential', { fetchImpl: async (url, options) => {
    requests.push({ url, accept: options.headers.Accept })
    if (url.includes('/actions/')) {
      if (options.headers.Accept !== 'application/vnd.github+json') return new Response('', { status: 415 })
      return new Response(zip)
    }
    if (options.headers.Accept !== 'application/octet-stream') return new Response('', { status: 415 })
    return new Response('installer')
  } })
  await stageBuildArchive(client, '/repos/test/build/actions/artifacts/7/zip', join(directory, 'target'))
  const binary = await client.download('/repos/test/downloads/releases/assets/9')
  let text = ''
  for await (const chunk of binary) text += Buffer.from(chunk).toString()
  assert.equal(text, 'installer')
  assert.deepEqual(requests.map(request => request.accept), ['application/vnd.github+json', 'application/octet-stream'])
})

test('retries complete GET reads after proxy resets, HTTP failures and interrupted JSON bodies', async () => {
  for (const kind of ['socket', 'status', 'body']) {
    let calls = 0
    const delays = []
    const messages = []
    const client = apiClient('https://api.github.com', 'Bearer synthetic-credential', {
      sleep: async ms => { delays.push(ms) }, progress: message => { messages.push(message) },
      fetchImpl: async () => {
        calls++
        if (calls === 1) {
          if (kind === 'socket') throw socketFailure()
          if (kind === 'status') return new Response('', { status: 503 })
          return { ok: true, status: 200, json: async () => { throw socketFailure() } }
        }
        return Response.json({ status: 'completed' })
      },
    })
    assert.deepEqual(await client.request('GET', '/repos/test/build/actions/runs/9?private=synthetic-query'), { status: 'completed' })
    assert.equal(calls, 2)
    assert.deepEqual(delays, [1000])
    assert.match(messages[0], /retry 1\/3.*(?:ECONNRESET|HTTP 503)/u)
    assert.doesNotMatch(messages.join('\n'), /credential|private|synthetic-query/u)
  }
})

test('bounds network retries and never blindly retries mutations, denied requests or malformed JSON', async () => {
  for (const kind of ['exhausted', 'mutation', 'denied', 'json']) {
    let calls = 0
    const client = apiClient('https://api.github.com', 'Bearer synthetic-credential', {
      sleep: async () => {}, progress: () => {}, fetchImpl: async () => {
        calls++
        if (kind === 'denied') return new Response('', { status: 403 })
        if (kind === 'json') return new Response('synthetic-private-response')
        throw socketFailure()
      },
    })
    await assert.rejects(client.request(kind === 'mutation' ? 'POST' : 'GET', '/resource'), error => {
      assert.doesNotMatch(error.message, /synthetic|credential/u)
      if (kind === 'exhausted') assert.match(error.message, /after 4 attempts.*ECONNRESET/u)
      if (kind === 'mutation') assert.match(error.message, /reconcile before retrying/u)
      if (kind === 'denied') assert.equal(error.status, 403)
      return true
    })
    assert.equal(calls, kind === 'exhausted' ? 4 : 1)
  }
})

test('restarts interrupted artifact extraction in an empty stage and rejects invalid ZIPs without retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-release-read-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = zipSync({ 'build-manifest.json': Buffer.from('{}'), 'Harness.exe': Buffer.from('installer') })
  let calls = 0
  const client = { download: async () => (async function* () {
    calls++
    if (calls === 1) { yield bytes.subarray(0, 55); throw socketFailure() }
    yield bytes
  })() }
  const output = join(directory, 'target')
  await stageBuildArchive(client, '/artifact', output, { sleep: async () => {}, progress: () => {} })
  assert.equal(calls, 2)
  assert.equal(await readFile(join(output, 'Harness.exe'), 'utf8'), 'installer')
  calls = 0
  await assert.rejects(stageBuildArchive({ download: async () => (async function* () {
    calls++; yield zipSync({ '../escape.exe': Buffer.from('bad') })
  })() }, '/artifact', join(directory, 'invalid'), { sleep: async () => {}, progress: () => {} }), /Invalid/u)
  assert.equal(calls, 1)
})

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

test('finds unpublished GitHub drafts across pages when the tag endpoint returns 404 and reconciles a lost create response', async () => {
  const draft = { id: 7, tag_name: 'test-tag', draft: true }
  const calls = []
  const client = { request: async (method, path) => {
    calls.push({ method, path })
    if (method === 'POST') throw socketFailure()
    if (path.includes('/tags/')) throw Object.assign(new Error('Not found'), { status: 404 })
    if (path.endsWith('page=1')) return Array.from({ length: 50 }, (_, id) => ({ tag_name: `another-${id}` }))
    return [draft]
  } }
  const destination = releaseDestination('GitHub', client, 'owner/repo', { github: true, target: commit })
  assert.deepEqual(await destination.find('test-tag'), draft)
  assert.deepEqual(await destination.create({ tag: 'test-tag', version, body: 'test' }), draft)
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(calls.filter(call => call.path.endsWith('page=2')).length, 2)
  client.request = async () => { throw Object.assign(new Error('Denied'), { status: 403 }) }
  await assert.rejects(destination.find('test-tag'), /Denied/u)
})

test('refuses ambiguous GitHub drafts and returns no match only after inspecting the release list', async () => {
  const client = { request: async (method, path) => {
    if (path.includes('/tags/')) throw Object.assign(new Error('Not found'), { status: 404 })
    return [{ tag_name: 'test-tag', draft: true }, { tag_name: 'test-tag', draft: true }]
  } }
  const destination = releaseDestination('GitHub', client, 'owner/repo', { github: true, target: commit })
  await assert.rejects(destination.find('test-tag'), /Ambiguous/u)
  client.request = async (method, path) => {
    if (path.includes('/tags/')) throw Object.assign(new Error('Not found'), { status: 404 })
    return []
  }
  assert.equal(await destination.find('test-tag'), undefined)
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

test('extracts descriptor-based binary entries containing embedded ZIP signatures using the central directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-release-descriptor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installer = Buffer.concat([Buffer.from('binary installer'),
    zipSync({ '../embedded.exe': Buffer.from('embedded binary data') }, { level: 0 })])
  const output = []
  const zip = new Zip((error, bytes) => { assert.ifError(error); output.push(bytes) })
  for (const [name, bytes] of [['build-manifest.json', Buffer.from('{}')], ['Harness.exe', installer]]) {
    const file = new ZipPassThrough(name)
    zip.add(file)
    file.push(bytes, true)
  }
  zip.end()
  async function* chunks() { for (const bytes of output) yield bytes }
  const directory = join(root, 'target')
  await extractBuildArchive(chunks(), directory)
  assert.deepEqual(await readFile(join(directory, 'Harness.exe')), installer)
  assert.deepEqual((await readdir(directory)).sort(), ['Harness.exe', 'build-manifest.json'])
})

test('rejects duplicate central-directory names and symbolic links and removes the temporary archive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-release-invalid-entry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const kind of ['duplicate', 'symlink']) {
    const output = []
    const zip = new Zip((error, bytes) => { assert.ifError(error); output.push(bytes) })
    for (const name of ['build-manifest.json', 'Harness.exe', ...(kind === 'duplicate' ? ['Harness.exe'] : [])]) {
      const file = new ZipPassThrough(name)
      if (kind === 'symlink' && name === 'Harness.exe') { file.os = 3; file.attrs = 0xa1ff0000 }
      zip.add(file)
      file.push(Buffer.from(name === 'build-manifest.json' ? '{}' : 'installer'), true)
    }
    zip.end()
    const directory = join(root, kind)
    await assert.rejects(extractBuildArchive((async function* () { yield* output })(), directory), /Invalid/u)
    assert.equal((await readdir(directory)).includes('.download.zip'), false)
  }
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

test('resumes the same hosted run after a full batch of transient read failures without redispatch', async () => {
  let time = 0
  let reads = 0
  const paths = []
  const progress = []
  const client = apiClient('https://api.github.com', 'Bearer fixture', {
    sleep: async ms => { time += ms }, progress: line => progress.push(line),
    fetchImpl: async () => {
      if (++reads <= 4) throw socketFailure()
      return Response.json(run)
    },
  })
  const result = await waitForDesktopBuild({ repository: 'test/build', commit, runId: 99,
    timeoutMs: 30_000, pollMs: 1000, now: () => time, sleep: async ms => { time += ms },
    progress: line => progress.push(line), request: (method, path) => {
      assert.equal(method, 'GET')
      paths.push(path)
      return client.request(method, path)
    } })
  assert.equal(result.id, 99)
  assert.deepEqual(paths, ['/repos/test/build/actions/runs/99', '/repos/test/build/actions/runs/99'])
  assert.ok(progress.some(line => line.includes('temporarily unavailable')))
  assert.ok(progress.every(line => !line.includes('synthetic credential')))
})

test('keeps the original deadline through repeated read outages and rejects permanent failures immediately', async () => {
  let time = 0
  let calls = 0
  await assert.rejects(waitForDesktopBuild({ repository: 'test/build', commit, runId: 99,
    timeoutMs: 10, pollMs: 4, now: () => time, sleep: async ms => { time += ms }, progress: () => {},
    request: async () => { calls++; throw Object.assign(new Error('transient'), { retryableReleaseRead: true }) },
  }), /Timed out.*99/u)
  assert.equal(time, 10)
  assert.equal(calls, 3)
  for (const failure of [Object.assign(new Error('denied'), { status: 403 }), new SyntaxError('malformed')]) {
    let permanentCalls = 0
    await assert.rejects(waitForDesktopBuild({ repository: 'test/build', commit, runId: 99,
      request: async () => { permanentCalls++; throw failure }, progress: () => {},
      sleep: async () => assert.fail('Permanent failures must not sleep'),
    }), error => error === failure)
    assert.equal(permanentCalls, 1)
  }
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
  }, assets: async () => [...assets], recoverAsset: async (_remote, asset) => asset, upload: async (id, file) => {
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

for (const interruption of ['existing', 'lost', 'exhausted']) test(`recovers ${interruption} GitHub draft uploads within the upload limit`, async () => {
  const bytes = Buffer.from('installer')
  const file = { name: 'Harness.exe', size: bytes.length, sha256: hash(bytes) }
  const pending = { id: 7, name: file.name, size: file.size, state: 'starter' }
  let asset = interruption === 'existing' ? pending : undefined
  let uploads = 0
  const remote = { id: 1, tag_name: release.tag, body: release.body, prerelease: true, draft: true, html_url: 'https://test/release' }
  const prefix = '/repos/owner/repo/releases'
  const calls = []
  const client = { request: async (method, path) => {
    calls.push(`${method} ${path}`)
    if (method === 'DELETE' && path === `${prefix}/assets/7`) { asset = undefined; return {} }
    if (method === 'PATCH') { remote.draft = false; return remote }
    if (path === `${prefix}/assets/7`) return asset
    if (path.includes('/assets?')) return asset ? [asset] : []
    if (path.includes('/tags/')) return remote
    assert.fail(`Unexpected ${method} ${path}`)
  }, download: async path => {
    calls.push(`download ${path}`)
    if (asset?.state !== 'uploaded') throw Object.assign(new Error('Not found'), { status: 404 })
    return (async function* () { yield bytes })()
  } }
  const target = releaseDestination('GitHub', client, 'owner/repo', { github: true, target: commit })
  target.upload = async () => {
    calls.push('upload')
    uploads++
    if (interruption === 'exhausted' || interruption === 'lost' && uploads === 1) {
      asset = pending
      throw socketFailure()
    }
    asset = { id: 8, name: file.name, size: file.size, state: 'uploaded', digest: `sha256:${file.sha256}` }
    return asset
  }
  const operation = publishDesktopRelease({ ...release, files: [file] }, [target])
  if (interruption === 'exhausted') await assert.rejects(operation, /remained incomplete/u)
  else assert.deepEqual(await operation, ['https://test/release'])
  assert.equal(calls.filter(call => call === `DELETE ${prefix}/assets/7`).length, interruption === 'exhausted' ? 3 : 1)
  assert.equal(uploads, { existing: 1, lost: 2, exhausted: 3 }[interruption])
  assert.equal(calls.includes(`download ${prefix}/assets/7`), false)
  assert.equal(calls.includes(`download ${prefix}/assets/8`), interruption !== 'exhausted')
  assert.equal(remote.draft, interruption === 'exhausted')
})

test('only discards a freshly confirmed incomplete GitHub asset inside a draft', async () => {
  const asset = { id: 7, name: 'Harness.exe', state: 'starter' }
  for (const kind of ['published', 'unknown', 'invalid-id', 'changed-id', 'changed-name', 'changed-state', 'denied', 'missing', 'delete-lost']) {
    const calls = []
    const client = { request: async (method, path) => {
      calls.push(method)
      if (kind === 'denied' || kind === 'missing') throw Object.assign(new Error(kind), { status: kind === 'denied' ? 403 : 404 })
      if (method === 'DELETE') throw socketFailure()
      assert.match(path, /\/assets\/7$/u)
      return { ...asset, ...kind === 'changed-id' ? { id: 8 } : {},
        ...kind === 'changed-name' ? { name: 'Other.exe' } : {}, ...kind === 'changed-state' ? { state: 'other' } : {} }
    } }
    const target = releaseDestination('GitHub', client, 'owner/repo', { github: true, target: commit })
    await assert.rejects(target.recoverAsset({ draft: kind !== 'published' },
      { ...asset, ...kind === 'unknown' ? { state: 'other' } : {}, ...kind === 'invalid-id' ? { id: '../other' } : {} }))
    assert.equal(calls.includes('DELETE'), kind === 'delete-lost', kind)
  }
})

test('keeps completed GitHub assets and observes an upload that completed before recovery', async () => {
  const pending = { id: 7, name: 'Harness.exe', state: 'starter' }
  const complete = { ...pending, state: 'uploaded' }
  const calls = []
  const target = releaseDestination('GitHub', { request: async (method) => { calls.push(method); return complete } },
    'owner/repo', { github: true, target: commit })
  assert.equal(await target.recoverAsset({ draft: false }, complete), complete)
  assert.equal(await target.recoverAsset({ draft: true }, pending), complete)
  assert.deepEqual(calls, ['GET'])
  const internal = releaseDestination('Gitea', {}, 'owner/repo', { target: commit, base: 'http://gitea.test' })
  assert.equal(await internal.recoverAsset({ draft: true }, pending), pending)
})

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
