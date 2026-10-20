import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/** Build a native content release from a private source checkout; links are never followed. */
export async function inspectCompanyContent(directory) {
  const require = createRequire(import.meta.url)
  const product = createRequire(require.resolve('@deepseek-harness/product-desktop'))
  const { companyContentRelease, contentDigest, COMPANY_CONTENT_MAX_BYTES } = await import(pathToFileURL(product.resolve('@deepseek-harness/product/company-content')).href)
  const root = resolve(directory)
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Content root must be an ordinary directory')
  const manifestPath = join(root, 'release.json')
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 8192) throw new Error('Invalid release manifest')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const files = {}
  let bytes = 0
  const walk = async (path) => {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not supported')
      if (entry.isDirectory()) { await walk(child); continue }
      if (!entry.isFile()) throw new Error('Only ordinary content files are supported')
      const stat = await lstat(child)
      bytes += stat.size
      if (bytes > COMPANY_CONTENT_MAX_BYTES || Object.keys(files).length >= 2048) throw new Error('Content release is too large')
      files[relative(root, child).replaceAll('\\', '/')] = (await readFile(child)).toString('base64')
    }
  }
  for (const kind of ['experts', 'skills']) {
    const path = join(root, kind)
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Symbolic links are not supported') }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error }
    await walk(path)
  }
  return companyContentRelease({ version: manifest.version, sha256: contentDigest(files), files })
}

async function main() {
  const [directory, mode] = process.argv.slice(2)
  if (!directory || mode !== '--check' && mode !== '--publish') throw new Error('Usage: publish-company-content.mjs <private-checkout> --check|--publish')
  const release = await inspectCompanyContent(directory)
  if (mode === '--publish') {
    const base = new URL(process.env.COMPANY_CONTENT_SERVER_URL ?? '')
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid company service URL')
    const token = process.env.COMPANY_CONTENT_PUBLISHER_TOKEN
    if (!token) throw new Error('Company publishing credential is required')
    const headers = { 'content-type': 'application/json', 'X-DeepSeek-Harness-Company-Publisher-Token': token }
    const request = async (path, init = {}) => {
      const response = await fetch(`${base.href.replace(/\/$/u, '')}${path}`, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`Company publication failed: HTTP ${response.status}`)
      const result = await response.json()
      if (result.success !== true) throw new Error('Company publication was rejected')
      return result.data
    }
    const current = await request('/api/v1/company-content')
    await request('/api/v1/admin/company-content/releases', { method: 'POST', body: JSON.stringify({ ...release, expectedVersion: current?.version ?? '0' }) })
  }
  console.log(JSON.stringify({ version: release.version, sha256: release.sha256, fileCount: Object.keys(release.files).length, published: mode === '--publish' }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Company content validation or publication failed; credentials and content were not logged.'); process.exitCode = 1 })
}
