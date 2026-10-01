import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
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
const api = (process.env.GITEA_API_URL ?? 'http://192.168.2.66:3300/api/v1').replace(/\/$/u, '')
const repository = process.env.GITEA_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? 'instudio/deepseek-harness-desktop'
const tag = process.env.GITEA_RELEASE_TAG ?? `desktop-v${version}`
const name = process.env.GITEA_RELEASE_NAME ?? `DeepSeek Harness ${version}`

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

async function request(path, init = {}) {
  const authorization = token !== undefined && token !== ''
    ? `token ${token}`
    : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { Authorization: authorization, ...(init.headers ?? {}) },
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

async function getOrCreateRelease() {
  try { return await request(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`) }
  catch (error) {
    if (error.status !== 404) throw error
    try {
      return await request(`/repos/${repository}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, name, body: `DeepSeek Harness ${version} desktop artifacts.\n\nWindows artifacts are unsigned.` }),
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

async function upload(releaseId, assetName, contentType, body) {
  return request(`/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  })
}

const release = await getOrCreateRelease()
const existing = await request(`/repos/${repository}/releases/${release.id}/assets`)
const existingNames = new Set(existing.map(asset => asset.name))
const sourceFiles = await releaseFiles(directory)
if (sourceFiles.length === 0) throw new Error(`no release files found in ${directory}`)
const manifest = []
const metadata = []
const sourceNames = new Set()
for (const file of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) {
  const details = await stat(file.path)
  const digest = await hash(file.path)
  const assetName = basename(file.name)
  if (sourceNames.has(assetName)) throw new Error(`duplicate release asset basename: ${assetName}`)
  sourceNames.add(assetName)
  manifest.push(`${digest}  ${assetName}`)
  metadata.push({ name: assetName, size: details.size, sha256: digest })
  if (existingNames.has(assetName)) throw new Error(`release asset already exists; refusing overwrite: ${assetName}`)
  await upload(release.id, assetName, 'application/octet-stream', await readFile(file.path))
  console.log(`uploaded ${assetName} (${details.size} bytes, sha256 ${digest})`)
}
const manifestName = `${platform}-SHA256SUMS.txt`
if (existingNames.has(manifestName)) throw new Error(`release asset already exists; refusing overwrite: ${manifestName}`)
await upload(release.id, manifestName, 'text/plain; charset=utf-8', `${manifest.join('\n')}\n`)

const metadataName = `${platform}-release.json`
if (existingNames.has(metadataName)) throw new Error(`release asset already exists; refusing overwrite: ${metadataName}`)
const releaseMetadata = {
  schemaVersion: 1,
  tag,
  version,
  platform,
  unsigned: platform.startsWith('win-'),
  checksumManifest: manifestName,
  assets: metadata,
}
await upload(release.id, metadataName, 'application/json; charset=utf-8', `${JSON.stringify(releaseMetadata, null, 2)}\n`)
await writeFile(join(root, `.gitea-release-${platform}.json`), `${JSON.stringify({ ...releaseMetadata, releaseId: release.id }, null, 2)}\n`)
console.log(`release ${tag}: ${platform} assets published at ${release.html_url}`)
