import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { publishPackageMirror } from '../scripts/package-mirror.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harness-package-mirror-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = await Promise.all(['desktop.exe', 'desktop-arm64.zip', 'desktop-x64.zip', 'nightly.yml', 'nightly-mac.yml'].map(async name => {
    const bytes = Buffer.from(name)
    const path = join(root, name)
    await writeFile(path, bytes)
    return { name, path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  const stored = new Map()
  const uploaded = []
  const client = {
    request: async () => [...stored.keys()].map(name => ({ name })),
    response: async (url, options) => {
      const name = new URL(url).pathname.split('/').at(-1)
      assert.equal(options.method, 'PUT')
      assert.match(url, /^http:\/\/internal.test\/api\/packages\/company\/generic\/desktop\/1.2.3\//u)
      const chunks = []
      for await (const chunk of options.body) chunks.push(chunk)
      if (name.startsWith('nightly')) for (const file of files.filter(file => file.name.endsWith('.exe') || file.name.endsWith('.zip'))) assert.ok(stored.has(file.name))
      stored.set(name, Buffer.concat(chunks))
      uploaded.push(name)
      return new Response(null, { status: 201 })
    },
  }
  const options = { packageUrl: 'http://public.test/gitea/api/packages/company/generic/desktop/',
    fetchImpl: async (url, request) => {
      assert.equal(request.headers, undefined)
      assert.equal(request.redirect, 'error')
      const name = new URL(url).pathname.split('/').at(-1)
      return new Response(stored.get(name), { status: stored.has(name) ? 200 : 404 })
    } }
  return { files, stored, uploaded, client, options, release: { version: '1.2.3', files } }
}

test('publishes complete three-platform packages before feeds, verifies anonymous bytes and resumes without writes', async t => {
  const f = await fixture(t)
  await publishPackageMirror(f.release, f.client, 'http://internal.test/api/v1', f.options)
  assert.equal(f.uploaded.length, f.files.length)
  f.uploaded.length = 0
  await publishPackageMirror(f.release, f.client, 'http://internal.test/api/v1', f.options)
  assert.equal(f.uploaded.length, 0)
})

test('rejects corrupt or inaccessible existing files instead of overwriting them', async t => {
  for (const failure of ['corrupt', 'unauthorized']) {
    const f = await fixture(t)
    for (const file of f.files) f.stored.set(file.name, Buffer.from(file.name))
    if (failure === 'corrupt') f.stored.set('desktop.exe', Buffer.from('incorrect'))
    else f.options.fetchImpl = async () => new Response(null, { status: 401 })
    await assert.rejects(publishPackageMirror(f.release, f.client, 'http://internal.test/api/v1', f.options), failure === 'corrupt' ? /checksum/u : /401/u)
    assert.equal(f.uploaded.length, 0)
  }
})

test('stops when an unexpected file or uncertain upload is encountered and reconciles before another write', async t => {
  const f = await fixture(t)
  f.stored.set('unlisted.exe', Buffer.from('unknown'))
  await assert.rejects(publishPackageMirror(f.release, f.client, 'http://internal.test/api/v1', f.options), /unexpected/u)
  assert.equal(f.uploaded.length, 0)
  f.stored.clear()
  f.client.response = async () => { throw new Error('uncertain upload') }
  await assert.rejects(publishPackageMirror(f.release, f.client, 'http://internal.test/api/v1', f.options), /uncertain/u)
  assert.equal(f.stored.size, 0)
})

test('rejects invalid API and mirror configuration before contacting authenticated storage', async t => {
  const f = await fixture(t)
  f.client.request = async () => { assert.fail('Invalid configuration must not reach storage') }
  for (const base of ['http://internal.test/not-api', 'http://internal.test/api/v1?token=x', 'http://user:password@internal.test/api/v1']) {
    await assert.rejects(publishPackageMirror(f.release, f.client, base, f.options), /API base/u)
  }
  for (const packageUrl of ['file:///api/packages/company/generic/desktop/',
    'http://user:password@public.test/api/packages/company/generic/desktop/',
    `${f.options.packageUrl}?token=x`]) {
    await assert.rejects(publishPackageMirror(f.release, f.client, 'http://internal.test/api/v1', { ...f.options, packageUrl }), /identity/u)
  }
})
