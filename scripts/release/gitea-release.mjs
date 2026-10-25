import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const run = promisify(execFile)
const allowed = /\.(?:exe|dmg|zip|blockmap|ya?ml|json)$/u

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}

const directory = resolve(required(arg('directory'), 'directory'))
const platform = required(arg('platform'), 'platform')
const version = required(arg('version') ?? process.env.GITEA_RELEASE_VERSION, 'version')
const token = process.env.GITEA_TOKEN?.trim()
const username = process.env.GITEA_USERNAME?.trim()
const password = process.env.GITEA_PASSWORD?.trim()
if ((token === undefined || token === '') && (username === undefined || username === '' || password === undefined || password === '')) {
  throw new Error('GITEA_TOKEN or GITEA_USERNAME/GITEA_PASSWORD is required')
}
const api = (process.env.GITEA_API_URL ?? 'http://192.168.2.67:30330/api/v1').replace(/\/$/u, '')
const repository = process.env.GITEA_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? 'instudio/deepseek-harness-desktop'
const tag = process.env.GITEA_RELEASE_TAG ?? `desktop-v${version}`
const name = process.env.GITEA_RELEASE_NAME ?? `DeepSeek Harness ${version}`
const draft = process.env.GITEA_RELEASE_DRAFT === 'true'
const finalize = process.env.GITEA_RELEASE_FINALIZE === 'true'
const expectedCommit = process.env.GITEA_RELEASE_COMMIT?.trim()
const replaceAssets = process.env.GITEA_RELEASE_REPLACE_ASSETS === 'true' || draft || finalize
const maxAttempts = 3

const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (rootManifest.version !== version) {
  throw new Error(`release version ${version} does not match package.json ${rootManifest.version}`)
}
if (tag !== `desktop-v${version}`) {
  throw new Error(`release tag must be desktop-v${version}, got ${tag}`)
}
if (expectedCommit !== undefined && !/^[0-9a-f]{40}$/u.test(expectedCommit)) {
  throw new Error(`GITEA_RELEASE_COMMIT must be a full commit SHA, got ${expectedCommit}`)
}
if (expectedCommit !== undefined) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  if (head !== expectedCommit) throw new Error(`release checkout ${head} does not match GITEA_RELEASE_COMMIT ${expectedCommit}`)
}

async function hash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function releaseFiles(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    // electron-builder keeps unpacked application contents beside release
    // assets (for example win-unpacked). Only top-level files are distributable.
    if (!entry.isDirectory() && allowed.test(entry.name)) files.push({ path: join(path, entry.name), name: entry.name })
  }
  return files
}

function authorizationHeader() {
  return token !== undefined && token !== ''
    ? `token ${token}`
    : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function retryable(error) {
  return error?.status === undefined || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
}

function backoff(attempt) {
  return new Promise(resolve => setTimeout(resolve, 500 * (2 ** (attempt - 1))))
}

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    duplex: init.body !== undefined && typeof init.body !== 'string' && !(init.body instanceof Uint8Array) ? 'half' : undefined,
    headers: { Authorization: authorizationHeader(), ...(init.headers ?? {}) },
  })
  const body = await response.text()
  let value
  try { value = body === '' ? undefined : JSON.parse(body) } catch { value = body }
  if (!response.ok) {
    const error = new Error(`Gitea API ${response.status} ${init.method ?? 'GET'} ${path}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    error.status = response.status
    throw error
  }
  return value
}

async function requestWithRetry(path, createInit, attempts = maxAttempts) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request(path, createInit())
    } catch (error) {
      lastError = error
      if (!retryable(error) || attempt === attempts) throw error
      await backoff(attempt)
    }
  }
  throw lastError
}

async function getOrCreateRelease() {
  try { return await request(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`) }
  catch (error) {
    if (error.status !== 404) throw error
    try {
      return await request(`/repos/${repository}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, name, draft, body: `DeepSeek Harness ${version} desktop artifacts.\n\nWindows artifacts are unsigned.` }),
      })
    }
    catch (createError) {
      // Windows and macOS jobs may reach an empty release concurrently. The
      // winner creates it; the loser must attach to that exact tag.
      if (createError.status !== 409 && createError.status !== 422) throw createError
      return request(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`)
    }
  }
}

async function upload(releaseId, assetName, contentType, bodyFactory) {
  return requestWithRetry(
    `/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    () => ({
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bodyFactory(),
    }),
  )
}

async function downloadHash(asset) {
  const url = asset.browser_download_url ?? asset.download_url
  if (typeof url !== 'string' || url === '') return undefined
  const response = await fetch(url, { headers: { Authorization: authorizationHeader() } })
  if (!response.ok || response.body === null) return undefined
  const digest = createHash('sha256')
  for await (const chunk of response.body) digest.update(chunk)
  return digest.digest('hex')
}

async function matches(asset, expectedSize, expectedSha256) {
  if (Number(asset.size) !== expectedSize) return false
  try {
    return await downloadHash(asset) === expectedSha256
  } catch {
    return false
  }
}

async function deleteAsset(releaseId, assetId) {
  await requestWithRetry(`/repos/${repository}/releases/${releaseId}/assets/${assetId}`, () => ({ method: 'DELETE' }))
}

async function ensureAsset(releaseId, existingAssets, asset) {
  const existing = existingAssets.find(candidate => candidate.name === asset.name)
  if (existing !== undefined) {
    if (await matches(existing, asset.size, asset.sha256)) {
      console.log(`reused ${asset.name} (${asset.size} bytes, sha256 ${asset.sha256})`)
      return existing
    }
    if (!replaceAssets) {
      throw new Error(`release asset already exists with different content; refusing overwrite: ${asset.name}`)
    }
    await deleteAsset(releaseId, existing.id)
    existingAssets.splice(existingAssets.indexOf(existing), 1)
  }

  try {
    const uploaded = await upload(releaseId, asset.name, asset.contentType, asset.bodyFactory)
    existingAssets.push(uploaded)
    return uploaded
  } catch (error) {
    // A connection can fail after Gitea has accepted the upload. Reconcile
    // before retrying so a rerun never creates duplicate business artifacts.
    const current = await requestWithRetry(`/repos/${repository}/releases/${releaseId}/assets`, () => ({}))
    const accepted = current.find(candidate => candidate.name === asset.name)
    if (accepted !== undefined && await matches(accepted, asset.size, asset.sha256)) {
      existingAssets.push(accepted)
      console.log(`reconciled ${asset.name} after an interrupted upload`)
      return accepted
    }
    throw error
  }
}

const release = await getOrCreateRelease()
if (draft && release.draft !== true) throw new Error(`release ${tag} already exists and is not a draft`)
const existing = await requestWithRetry(`/repos/${repository}/releases/${release.id}/assets`, () => ({}))
const sourceFiles = await releaseFiles(directory)
if (sourceFiles.length === 0) throw new Error(`no release files found in ${directory}`)
const manifest = []
const metadata = []
const sourceNames = new Set()
const desiredAssets = []
for (const file of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) {
  const details = await stat(file.path)
  const digest = await hash(file.path)
  const assetName = basename(file.name)
  if (sourceNames.has(assetName)) throw new Error(`duplicate release asset basename: ${assetName}`)
  sourceNames.add(assetName)
  manifest.push(`${digest}  ${assetName}`)
  metadata.push({ name: assetName, size: details.size, sha256: digest })
  desiredAssets.push({
    name: assetName,
    size: details.size,
    sha256: digest,
    contentType: 'application/octet-stream',
    bodyFactory: () => createReadStream(file.path),
  })
}
const manifestName = `${platform}-SHA256SUMS.txt`
const manifestBody = `${manifest.join('\n')}\n`
desiredAssets.push({
  name: manifestName,
  size: Buffer.byteLength(manifestBody),
  sha256: createHash('sha256').update(manifestBody).digest('hex'),
  contentType: 'text/plain; charset=utf-8',
  bodyFactory: () => manifestBody,
})

const metadataName = `${platform}-release.json`
const releaseMetadata = {
  schemaVersion: 1,
  tag,
  version,
  platform,
  unsigned: platform.startsWith('win-'),
  checksumManifest: manifestName,
  assets: metadata,
}
const metadataBody = `${JSON.stringify(releaseMetadata, null, 2)}\n`
desiredAssets.push({
  name: metadataName,
  size: Buffer.byteLength(metadataBody),
  sha256: createHash('sha256').update(metadataBody).digest('hex'),
  contentType: 'application/json; charset=utf-8',
  bodyFactory: () => metadataBody,
})
for (const asset of desiredAssets) {
  await ensureAsset(release.id, existing, asset)
  console.log(`published ${asset.name} (${asset.size} bytes, sha256 ${asset.sha256})`)
}
await writeFile(join(root, `.gitea-release-${platform}.json`), `${JSON.stringify({ ...releaseMetadata, releaseId: release.id }, null, 2)}\n`)
if (finalize) {
  await request(`/repos/${repository}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false }),
  })
}
console.log(`release ${tag}: ${platform} assets published at ${release.html_url}`)
