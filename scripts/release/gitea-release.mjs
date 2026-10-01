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

async function filesUnder(path, relative = '') {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(child, join(relative, entry.name)))
    else if (allowed.test(entry.name)) files.push({ path: child, name: join(relative, entry.name).replaceAll('\\', '/') })
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
    return await request(`/repos/${repository}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name, body: `DeepSeek Harness ${version} desktop artifacts.\n\nWindows artifacts are unsigned.` }),
    })
  }
}

const release = await getOrCreateRelease()
const existing = await request(`/repos/${repository}/releases/${release.id}/assets`)
const existingNames = new Set(existing.map(asset => asset.name))
const sourceFiles = await filesUnder(directory)
if (sourceFiles.length === 0) throw new Error(`no release files found in ${directory}`)
const manifest = []
for (const file of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) {
  const details = await stat(file.path)
  const digest = await hash(file.path)
  manifest.push(`${digest}  ${file.name}`)
  const assetName = `${platform}-${basename(file.name)}`
  if (existingNames.has(assetName)) throw new Error(`release asset already exists; refusing overwrite: ${assetName}`)
  await request(`/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await readFile(file.path),
  })
  console.log(`uploaded ${assetName} (${details.size} bytes, sha256 ${digest})`)
}
const manifestName = `${platform}-SHA256SUMS.txt`
if (existingNames.has(manifestName)) throw new Error(`release asset already exists; refusing overwrite: ${manifestName}`)
await request(`/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(manifestName)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: `${manifest.join('\n')}\n`,
})
await writeFile(join(root, `.gitea-release-${platform}.json`), `${JSON.stringify({ tag, version, platform, releaseId: release.id, files: manifest }, null, 2)}\n`)
console.log(`release ${tag}: ${platform} assets published at ${release.html_url}`)
