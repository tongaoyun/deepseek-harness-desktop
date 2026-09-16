import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function macUpdateManifest(version, commit, manifests, base) {
  const platforms = {}
  for (const arch of ['arm64', 'x64']) {
    const manifest = manifests.find((item) => item.arch === arch)
    if (!manifest || manifest.version !== version || manifest.commit !== commit || !manifest.signature?.trim()
      || !manifest.files?.length) throw new Error(`Missing or mismatched ${arch} release`)
    const archive = manifest.files.find((file) => file.name === `xiaoyin_${version}_${arch}.app.tar.gz`)
    if (!archive || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error(`Invalid ${arch} updater archive`)
    platforms[arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64'] = {
      signature: manifest.signature.trim(), url: `${base}/${encodeURIComponent(archive.name)}`,
    }
  }
  return { version, notes: `小胤桌面端 ${version}`, platforms }
}

async function main() {
  const [mode, arch] = process.argv.slice(2)
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const commit = process.env.GITHUB_SHA
  if (!commit || process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Release tag and commit must match the package')
  if (!process.env.RELEASE_USERNAME || !process.env.RELEASE_CREDENTIAL) throw new Error('Release credentials are required')
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.macos.conf.json', import.meta.url), 'utf8'))
  const feed = config.plugins.updater.endpoints[0]
  const server = new URL(feed).origin
  const base = `${server}/api/packages/instudio/generic/xiaoyin-desktop-macos/${version}`
  const headers = { Authorization: `Basic ${Buffer.from(`${process.env.RELEASE_USERNAME}:${process.env.RELEASE_CREDENTIAL}`).toString('base64')}` }
  async function request(url, init = {}, allowed = []) {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(300_000) })
    if (!response.ok && !allowed.includes(response.status)) throw new Error(`${init.method || 'GET'} ${new URL(url).pathname}: HTTP ${response.status}`)
    return response
  }
  async function responseDigest(response) {
    if (!response.body) throw new Error('Release artifact response did not contain a body')
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) {
      hash.update(chunk)
      bytes += chunk.length
    }
    return { bytes, sha256: hash.digest('hex') }
  }
  async function immutable(name, bytes) {
    const url = `${base}/${encodeURIComponent(name)}`
    const existing = await request(url, {}, [404])
    const expected = digest(bytes)
    if (existing.ok) {
      const actual = await responseDigest(existing)
      if (actual.sha256 !== expected) throw new Error(`Refusing to replace ${name}`)
      return
    }
    await request(url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })
    const actual = await responseDigest(await request(url))
    if (actual.sha256 !== expected) throw new Error(`Upload verification failed: ${name}`)
  }
  if (mode === 'stage') {
    if (!['arm64', 'x64'].includes(arch)) throw new Error('Expected arm64 or x64')
    const artifactArch = arch === 'arm64' ? 'aarch64' : 'x64'
    const files = []
    for (const [source, name] of [
      ['小胤.app.tar.gz', `xiaoyin_${version}_${arch}.app.tar.gz`],
      ['小胤.app.tar.gz.sig', `xiaoyin_${version}_${arch}.app.tar.gz.sig`],
      [`小胤_${version}_${artifactArch}.dmg`, `xiaoyin_${version}_${arch}.dmg`],
    ]) {
      const bytes = await readFile(new URL(`../macos-artifacts/${source}`, import.meta.url))
      if (!bytes.length) throw new Error(`Empty artifact: ${source}`)
      await immutable(name, bytes)
      files.push({ name, bytes: bytes.length, sha256: digest(bytes) })
    }
    const signature = (await readFile(new URL('../macos-artifacts/小胤.app.tar.gz.sig', import.meta.url), 'utf8')).trim()
    const manifest = { version, commit, arch, signature, files }
    await immutable(`${arch}.json`, Buffer.from(JSON.stringify(manifest)))
    console.log(`Verified and staged ${arch} ${version}; update feed unchanged`)
  } else if (mode === 'publish') {
    const manifests = await Promise.all(['arm64', 'x64'].map(async (arch) => (await request(`${base}/${arch}.json`)).json()))
    const latest = macUpdateManifest(version, commit, manifests, base)
    await Promise.all(manifests.flatMap((manifest) => manifest.files.map(async (file) => {
      if (!/^xiaoyin_[\w.-]+\.(?:dmg|app\.tar\.gz(?:\.sig)?)$/.test(file.name)) throw new Error('Invalid artifact name')
      const actual = await responseDigest(await request(`${base}/${encodeURIComponent(file.name)}`))
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`Release checksum mismatch: ${file.name}`)
    })))
    const bytes = Buffer.from(JSON.stringify(latest))
    await immutable('latest.json', bytes)
    const previous = await request(feed, {}, [404])
    if (previous.ok) {
      const published = await previous.json()
      if (published.version.localeCompare(version, 'en', { numeric: true }) > 0) throw new Error('Refusing to downgrade the Mac update feed')
    }
    // A separate Mac feed prevents the Windows publisher from dropping Darwin platforms.
    await request(`${server}/api/v1/packages/instudio/generic/xiaoyin-desktop-updater-macos/latest`, { method: 'DELETE' }, [404])
    await request(feed, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/json' } })
    const readBack = await fetch(feed, { signal: AbortSignal.timeout(30_000) })
    if (!readBack.ok || digest(Buffer.from(await readBack.arrayBuffer())) !== digest(bytes)) throw new Error('Update feed read-back failed')
    console.log(`Published verified Apple Silicon and Intel update feed for ${version}`)
  } else throw new Error('Expected stage or publish')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
