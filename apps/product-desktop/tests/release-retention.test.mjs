import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyReleaseRetention, planReleaseRetention, readReleaseInventory, retentionClient } from '../scripts/release-retention.mjs'

function release(id, overrides = {}) {
  const version = `0.2.1-rc.2.20261021.${id}.1`
  return { id, tag_name: `v${version}`, draft: false, prerelease: true,
    published_at: `2026-10-${String(id + 10).padStart(2, '0')}T00:00:00Z`,
    assets: ['win-x64-unsigned.exe', 'mac-arm64-unsigned.dmg',
      'mac-arm64-unsigned.zip', 'win-x64-unsigned.exe.blockmap', 'SHA256SUMS.txt', 'build-manifest.json']
      .map((suffix, index) => ({ id: id * 10 + index, size: 1024,
        name: suffix.includes('.') && !['SHA256SUMS.txt', 'build-manifest.json'].includes(suffix)
          ? `deepseek-harness-${version}-${suffix}` : suffix })), ...overrides }
}

function fixture(rows) {
  let releases = structuredClone(rows)
  const calls = []
  const client = { async request(method, path) {
    calls.push({ method, path })
    const id = Number(path.split('/').at(-1))
    if (method === 'DELETE') { releases = releases.filter(row => row.id !== id); return null }
    if (path.includes('?')) return structuredClone(releases)
    return structuredClone(releases.find(row => row.id === id))
  } }
  return { client, calls, rows: () => releases }
}

test('keeps two complete versions including every platform and update file', async () => {
  const rows = [release(1), release(5), release(3), release(4), release(2)]
  const plan = planReleaseRetention(rows)
  assert.deepEqual(plan.keep.map(row => row.id), [5, 4])
  assert.deepEqual(plan.remove.map(row => row.id), [3, 2, 1])
  const { client, calls, rows: current } = fixture(rows)
  assert.equal(await applyReleaseRetention(client, 'example/downloads', plan), 3)
  assert.deepEqual(current().map(row => row.id), [5, 4])
  assert.deepEqual(current().map(row => row.assets), [rows[1].assets, rows[3].assets])
  assert.equal(calls.some(call => /assets|tags/u.test(call.path)), false)
})

test('development packages cannot displace the native updater releases or unfinished drafts', () => {
  const plan = planReleaseRetention([release(1), release(2), release(3), release(4, { prerelease: false }),
    release(5, { prerelease: false }), release(6, { prerelease: false }), release(7, { draft: true, published_at: null }),
    { id: 100, tag_name: 'unrelated-v1' }])
  assert.deepEqual(plan.keep.map(row => row.id), [6, 5, 3, 2])
  assert.deepEqual(plan.remove.map(row => row.id), [4, 1])
  assert.deepEqual(plan.excluded.map(row => row.id), [7, 100])
})

test('rejects deletion when either replacement version lacks a supported platform', () => {
  for (const target of ['win-x64', 'mac-arm64']) {
    for (const id of [2, 3]) {
      const rows = [release(1), release(2), release(3)]
      rows.find(row => row.id === id).assets = rows.find(row => row.id === id).assets.filter(asset => !asset.name.includes(target))
      assert.throws(() => planReleaseRetention(rows), new RegExp(`lacks ${target}`, 'u'))
    }
  }
})

test('empty historical records can expire without pretending installer files exist', () => {
  const plan = planReleaseRetention([release(1, { assets: [] }), release(2, { assets: [] }), release(3, { assets: [] })])
  assert.deepEqual(plan.remove.map(row => row.id), [1])
})

test('rejects ambiguous identity, dates, sizes and omitted asset inventories', () => {
  for (const rows of [[release(1), release(1)], [release(1, { published_at: null })],
    [release(1, { assets: undefined })], [release(1, { assets: [{ id: 2, name: 'x', size: -1 }] })]]) {
    assert.throws(() => planReleaseRetention(rows), /Invalid/u)
  }
})

test('reads subsequent release pages before selecting retained versions', async () => {
  const calls = []
  const client = { async request(method, path) {
    calls.push(path)
    return path.endsWith('page=1') ? Array.from({ length: 50 }, (_, id) => ({ id })) : [{ id: 51 }]
  } }
  assert.equal((await readReleaseInventory(client, 'example/downloads')).length, 51)
  assert.equal(calls.length, 2)
  await assert.rejects(readReleaseInventory(client, '../downloads'), /Invalid release repository/u)
})

test('rejects a failed or truncated inventory instead of pruning the visible page', async () => {
  let calls = 0
  await assert.rejects(readReleaseInventory({ request: async () => {
    calls++
    if (calls === 2) throw new Error('permission failure')
    return Array.from({ length: 50 }, (_, id) => ({ id }))
  } }, 'example/downloads'), /permission failure/u)
  await assert.rejects(readReleaseInventory({ request: async () => ({ message: 'denied' }) }, 'example/downloads'), /Invalid release page/u)
})

test('stops before deletion when a retained or expired release changes', async () => {
  for (const id of [1, 3]) {
    const rows = [release(1), release(2), release(3)]
    const plan = planReleaseRetention(rows)
    const { client, calls } = fixture(rows.map(row => row.id === id ? { ...row, draft: true } : row))
    await assert.rejects(applyReleaseRetention(client, 'example/downloads', plan), /release changed/u)
    assert.equal(calls.some(call => call.method === 'DELETE'), false)
  }
})

test('stops on a deletion error without retrying or deleting another version', async () => {
  const rows = [release(1), release(2), release(3), release(4)]
  const { client, calls } = fixture(rows)
  const original = client.request
  client.request = async (method, path) => {
    if (method === 'DELETE') { calls.push({ method, path }); throw new Error('HTTP 403') }
    return original(method, path)
  }
  await assert.rejects(applyReleaseRetention(client, 'example/downloads', planReleaseRetention(rows)), /HTTP 403/u)
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1)
})

test('requires the deleted release to disappear from the destination', async () => {
  const rows = [release(1), release(2), release(3)]
  const { client } = fixture(rows)
  const original = client.request
  client.request = (method, path) => method === 'DELETE' ? null : original(method, path)
  await assert.rejects(applyReleaseRetention(client, 'example/downloads', planReleaseRetention(rows)), /not observed/u)
})

test('redacts transport credentials and fails on API permission errors', async () => {
  const client = retentionClient('https://api.github.com', 'private-value', async () => {
    throw new Error('https://username:private-value@proxy/')
  })
  await assert.rejects(client.request('GET', '/repos/example/downloads/releases'), error => {
    assert.equal(error.message.includes('private-value'), false)
    return /transport failed/u.test(error.message)
  })
  const denied = retentionClient('https://api.github.com', 'private-value', async () => new Response('', { status: 403 }))
  await assert.rejects(denied.request('DELETE', '/repos/example/downloads/releases/1'), /HTTP 403/u)
})

test('serializes daily cleanup with publication and keeps manual runs in preview by default', () => {
  const workflow = readFileSync(new URL('../../../.gitea/workflows/desktop-release-retention.yml', import.meta.url), 'utf8')
  const publication = readFileSync(new URL('../../../.gitea/workflows/github-desktop-sync.yml', import.meta.url), 'utf8')
  for (const source of [workflow, publication]) {
    assert.match(source, /group: github-desktop-sync/u)
    assert.match(source, /cancel-in-progress: false/u)
  }
  assert.match(workflow, /node apps\/product-desktop\/scripts\/release-retention\.mjs --apply/u)
  assert.match(workflow, /cron: '0 1 \* \* \*'/u)
  assert.match(workflow, /default: false/u)
  assert.match(workflow, /if \[ "\$RETENTION_APPLY" = "true" \]/u)
})
