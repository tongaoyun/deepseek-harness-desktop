/** Retain two published desktop versions per update channel, with all three installers together. */
import { resolve } from 'node:path'

const releaseTag = /^v\d+\.\d+\.\d+-(?:alpha\.\d+|beta\.\d+|rc\.\d+|test)\.\d{8}\.\d+\.\d+$/u
const targets = ['win-x64', 'mac-arm64', 'mac-x64']
const identity = release => JSON.stringify([release.id, release.tag_name, release.draft, release.prerelease,
  release.published_at, release.updated_at, release.body,
  release.assets.map(asset => [asset.id, asset.name, asset.size, asset.updated_at]).sort()])

/**
 * Select whole published releases; development and native-update channels each retain two versions.
 * @param {object[]} releases Complete release inventory including assets.
 * @returns {object} Retained, expired and excluded releases.
 */
export function planReleaseRetention(releases) {
  if (!Array.isArray(releases)) throw new Error('Invalid release inventory')
  const eligible = []
  const excluded = []
  const ids = new Set()
  const tags = new Set()
  for (const release of releases) {
    if (!releaseTag.test(release.tag_name ?? '')) { excluded.push(release); continue }
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || ids.has(release.id)
      || tags.has(release.tag_name) || typeof release.draft !== 'boolean'
      || typeof release.prerelease !== 'boolean' || !Array.isArray(release.assets)
      || release.assets.some(asset => !Number.isSafeInteger(asset.id) || typeof asset.name !== 'string'
        || !Number.isSafeInteger(asset.size) || asset.size < 0)) throw new Error('Invalid desktop release metadata')
    ids.add(release.id)
    tags.add(release.tag_name)
    if (release.draft) { excluded.push(release); continue }
    if (!Number.isFinite(Date.parse(release.published_at))) throw new Error('Invalid release publication date')
    eligible.push(release)
  }
  const keep = []
  const remove = []
  for (const prerelease of [false, true]) {
    const channel = eligible.filter(release => release.prerelease === prerelease)
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id)
    const retained = channel.slice(0, 2)
    const expired = channel.slice(2)
    // Empty historical Gitea records can expire; occupied releases need complete replacements.
    if (expired.some(release => release.assets.some(asset => asset.size > 0))) {
      for (const release of retained) {
        const version = release.tag_name.slice(1)
        for (const target of targets) {
          const extension = target === 'win-x64' ? 'exe' : 'dmg'
          if (!release.assets.some(asset => asset.size > 0 && ['unsigned', 'internal', 'signed']
            .some(mode => asset.name === `deepseek-harness-${version}-${target}-${mode}.${extension}`))) {
            throw new Error(`Retained release ${release.tag_name} lacks ${target} installer`)
          }
        }
      }
    }
    keep.push(...retained)
    remove.push(...expired)
  }
  return { keep, remove, excluded }
}

/**
 * Read all release pages before planning; never delete from a partial inventory.
 * @param {object} client Release API adapter with request(method, path).
 * @param {string} repository Validated owner/repo.
 * @returns {Promise<object[]>} Complete inventory including asset metadata.
 */
export async function readReleaseInventory(client, repository) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)) throw new Error('Invalid release repository')
  const releases = []
  for (let page = 1; page <= 100; page++) {
    const rows = await client.request('GET', `/repos/${repository}/releases?limit=50&per_page=50&page=${page}`)
    if (!Array.isArray(rows)) throw new Error('Invalid release page')
    releases.push(...rows)
    if (rows.length < 50) return releases
  }
  throw new Error('Release inventory exceeds pagination limit')
}

/**
 * Reconcile before each deletion; preserve tags, drafts and every file of retained releases.
 * @param {object} client Release API adapter.
 * @param {string} repository Destination owner/repo.
 * @param {object} plan Previously validated release plan.
 * @returns {Promise<number>} Number of deleted releases.
 */
export async function applyReleaseRetention(client, repository, plan) {
  const prefix = `/repos/${repository}/releases`
  for (const retained of plan.keep) {
    if (identity(await client.request('GET', `${prefix}/${retained.id}`)) !== identity(retained)) {
      throw new Error('Retained release changed; cleanup stopped')
    }
  }
  for (const expired of plan.remove) {
    if (identity(await client.request('GET', `${prefix}/${expired.id}`)) !== identity(expired)) {
      throw new Error('Expired release changed; cleanup stopped')
    }
    await client.request('DELETE', `${prefix}/${expired.id}`)
  }
  const remaining = await readReleaseInventory(client, repository)
  if (remaining.some(release => plan.remove.some(expired => expired.id === release.id))) {
    throw new Error('Release deletion was not observed; reconcile before retrying')
  }
  return plan.remove.length
}

/**
 * Build a credential-redacting, origin-bound JSON client; HTTP errors stop cleanup.
 * @param {string} base API origin/prefix.
 * @param {string} authorization Authorization header value.
 * @param {Function} fetchImpl HTTP transport.
 * @returns {object} Release API adapter.
 */
export function retentionClient(base, authorization, fetchImpl = fetch) {
  const origin = new URL(base).origin
  return { async request(method, path) {
    const url = new URL(base + path)
    if (url.origin !== origin) throw new Error('Release API origin changed')
    let response
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { Accept: 'application/json', Authorization: authorization } })
    } catch (error) {
      // Transport errors can contain proxy credentials; expose only the destination host.
      throw new Error(`Release retention ${method} ${url.host} transport failed; reconcile before retrying`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Release retention ${method} ${url.host} failed (HTTP ${response.status})`)
    }
    return response.status === 204 ? null : response.json()
  } }
}

async function main() {
  const required = name => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: release-retention.mjs [--apply]')
  const destinations = [{ name: 'Gitea', repository: required('GITEA_REPOSITORY'),
    client: retentionClient(required('GITEA_API_URL'), process.env.GITEA_TOKEN
      ? `token ${process.env.GITEA_TOKEN}` : `Basic ${Buffer.from(`${required('GITEA_USERNAME')}:${required('GITEA_PASSWORD')}`).toString('base64')}`) }]
  const github = retentionClient('https://api.github.com', `Bearer ${required('GITHUB_DESKTOP_TOKEN')}`)
  const repositories = [...new Set(required('GITHUB_DOWNLOAD_REPOSITORIES').split(',').map(value => value.trim()))]
  destinations.push(...repositories.map(repository => ({ name: 'GitHub downloads', repository, client: github })))
  // All destinations must be readable and valid before any service is modified.
  for (const destination of destinations) {
    destination.plan = planReleaseRetention(await readReleaseInventory(destination.client, destination.repository))
  }
  for (const { name, repository, client, plan } of destinations) {
    console.log(JSON.stringify({ destination: name, repository, apply: process.argv.includes('--apply'),
      keep: plan.keep.map(release => release.tag_name), remove: plan.remove.map(release => release.tag_name),
      excluded: plan.excluded.map(release => release.tag_name),
      expiredBytes: plan.remove.reduce((total, release) => total + release.assets.reduce((size, asset) => size + asset.size, 0), 0) }))
    if (process.argv.includes('--apply')) await applyReleaseRetention(client, repository, plan)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
