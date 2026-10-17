/** Verify hosted build archives and stage identical, immutable desktop releases. */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { openPromise } from 'yauzl'
import { githubBuildVersion } from './github-package.mjs'
import { gt, valid } from 'semver'
import { productSigningMode, productUpdateFeeds } from './update-release.mjs'

export const RELEASE_TARGETS = ['win-x64', 'mac-arm64', 'mac-x64']
const MAX_FILE = 2 * 1024 ** 3
const MAX_ARCHIVE = 3 * 1024 ** 3
const safeName = name => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** @param {string} path File path. @returns {Promise<string>} Streaming SHA-256. */
export async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Stage a bounded ZIP and extract central-directory entries with path and expanded-byte limits.
 * @param {AsyncIterable<Uint8Array>} chunks Downloaded ZIP chunks.
 * @param {string} directory New staging directory.
 * @returns {Promise<void>} Resolves after the complete archive is decoded.
 */
export async function extractBuildArchive(chunks, directory) {
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const archive = join(directory, '.download.zip')
  const names = new Set()
  let expanded = 0
  let compressed = 0
  let zip
  let inspecting = false
  try {
    await pipeline(Readable.from(chunks), new Transform({ transform(bytes, encoding, callback) {
      compressed += bytes.length
      callback(compressed > MAX_ARCHIVE ? new Error('Hosted artifact archive exceeds download limits') : null, bytes)
    } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
    inspecting = true
    zip = await openPromise(archive, { lazyEntries: true, strictFileNames: true, autoClose: false })
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName
      const type = (entry.externalFileAttributes >>> 16) & 0xf000
      if (!safeName(name) || !(name === 'build-manifest.json' || /\.(?:exe|dmg|zip|blockmap)$/u.test(name) || /^(?:win-x64|mac-arm64|mac-x64)-nightly\.yml$/u.test(name))
        || names.has(name) || names.size >= 16 || ![0, 0x8000].includes(type)
        || entry.isEncrypted() || entry.uncompressedSize > MAX_FILE) throw new Error('Invalid hosted artifact entry')
      names.add(name)
      let size = 0
      await pipeline(await zip.openReadStreamPromise(entry), new Transform({ transform(bytes, encoding, callback) {
        size += bytes.length
        expanded += bytes.length
        callback(size > MAX_FILE || expanded > MAX_ARCHIVE || (name === 'build-manifest.json' || name.endsWith('.yml')) && size > 64 * 1024
          ? new Error('Hosted artifact exceeds extraction limits') : null, bytes)
      } }), createWriteStream(join(directory, name), { flags: 'wx', mode: 0o600 }))
    }
    if (!names.has('build-manifest.json')) throw new Error('Incomplete hosted artifact archive')
  } catch (error) {
    if (!inspecting) throw error
    throw new Error('Invalid hosted artifact ZIP')
  } finally {
    if (zip?.isOpen) {
      const closed = once(zip, 'close')
      zip.close()
      await closed
    }
    await rm(archive, { force: true })
  }
}

/**
 * Require all platforms, one version/source and byte-identical file hashes before publication.
 * @param {string} directory Root containing one extracted directory per platform.
 * @param {object} run Successful hosted run identity.
 * @param {string} commit Requested source commit.
 * @param {string} productVersion Source desktop version.
 * @param {object} options Expected signing mode and public download repository; omitted accepts development installers only.
 * @returns {Promise<object>} Verified files, release identity and aggregate manifest.
 */
export async function collectDesktopRelease(directory, run, commit, productVersion, options = {}) {
  const signing = productSigningMode(options.signing)
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== commit
    || !/^[a-f0-9]{40}$/u.test(commit) || !Number.isSafeInteger(run.id) || run.id <= 0
    || !Number.isSafeInteger(run.run_number) || !Number.isSafeInteger(run.run_attempt)) {
    throw new Error('A successful build of the exact source is required')
  }
  const manifests = []
  const files = []
  const names = new Set()
  const expectedVersion = githubBuildVersion({ PACKAGE_SOURCE_SHA: commit, GITHUB_RUN_NUMBER: String(run.run_number),
    GITHUB_RUN_ATTEMPT: String(run.run_attempt), PACKAGE_BUILD_DATE: run.created_at }, productVersion)
  for (const target of RELEASE_TARGETS) {
    const folder = join(directory, target)
    const manifest = JSON.parse(await readFile(join(folder, 'build-manifest.json'), 'utf8'))
    if (manifest.target !== target || manifest.commit !== commit || manifest.signing !== signing
      || typeof manifest.version !== 'string'
      || !/^\d+\.\d+\.\d+-(?:alpha\.\d+|beta\.\d+|rc\.\d+|test)\.\d{8}\.\d+\.\d+$/u.test(manifest.version)
      || manifest.version !== expectedVersion
      || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 || manifest.artifacts.length > 15) {
      throw new Error(`Invalid ${target} build manifest`)
    }
    if (manifests.length && manifest.version !== manifests[0].version) throw new Error('Platform versions differ')
    const required = target === 'win-x64' ? '.exe' : '.dmg'
    if (manifest.artifacts.filter(file => file.name?.endsWith(required)).length !== 1) throw new Error(`Missing ${target} installer`)
    for (const artifact of manifest.artifacts) {
      if (!safeName(artifact.name) || !(/\.(?:exe|dmg|zip|blockmap)$/u.test(artifact.name) || signing === 'signed' && artifact.name === `${target}-nightly.yml`)
        || names.has(artifact.name) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_FILE
        || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? '')) throw new Error(`Invalid ${target} artifact`)
      names.add(artifact.name)
      const path = join(folder, artifact.name)
      if ((await stat(path)).size !== artifact.size || await fileHash(path) !== artifact.sha256) {
        throw new Error(`Artifact checksum mismatch: ${artifact.name}`)
      }
      files.push({ ...artifact, path })
    }
    const actual = (await readdir(folder)).sort()
    const expected = ['build-manifest.json', ...manifest.artifacts.map(file => file.name)].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unlisted ${target} artifact`)
    manifests.push(manifest)
  }
  const version = manifests[0].version
  if (signing === 'signed') {
    const feeds = await productUpdateFeeds(manifests, files, options.downloadRepository, version, run.created_at)
    for (const feed of feeds) {
      const path = join(directory, feed.name)
      await writeFile(path, feed.bytes, { mode: 0o600, flag: 'wx' })
      files.push({ path, name: feed.name, size: Buffer.byteLength(feed.bytes), sha256: digest(feed.bytes) })
    }
  }
  const aggregate = { version, commit, signing, githubRunId: run.id, githubRunAttempt: run.run_attempt,
    targets: manifests }
  const manifestBytes = JSON.stringify(aggregate, null, 2) + '\n'
  const sums = files.map(file => `${file.sha256}  ${file.name}`).sort().join('\n') + '\n'
  for (const [name, bytes] of [['build-manifest.json', manifestBytes], ['SHA256SUMS.txt', sums]]) {
    const path = join(directory, name)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    files.push({ path, name, size: Buffer.byteLength(bytes), sha256: digest(bytes) })
  }
  return { version, tag: `v${version}`, commit, files, prerelease: signing === 'unsigned',
    body: `${signing === 'signed' ? 'Signed product desktop update.' : 'Unsigned development desktop build.'}\n\nSource: ${commit}\nManifest SHA-256: ${digest(manifestBytes)}\n\nWindows x64, macOS ARM64 and macOS Intel. ${signing === 'signed' ? 'Native updates require download and restart confirmation.' : 'No automatic update feed.'}\n` }
}

/**
 * Wait for the correlated hosted run; rejected, failed or cancelled builds never publish.
 * @param {object} options Hosted API, source and polling policy.
 * @returns {Promise<object>} Exact successful run.
 */
export async function waitForDesktopBuild({ request, repository, commit, deliveryId, runId,
  timeoutMs = 150 * 60_000, pollMs = 15_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, progress = console.log }) {
  const deadline = now() + timeoutMs
  let selected = runId
  let previous
  while (now() < deadline) {
    let run
    if (selected) run = await request('GET', `/repos/${repository}/actions/runs/${selected}`)
    else {
      const result = await request('GET', `/repos/${repository}/actions/workflows/product-desktop-package.yml/runs?event=workflow_dispatch&head_sha=${commit}&per_page=100`)
      const matches = result.workflow_runs.filter(item => item.display_title === `Desktop ${commit} / ${deliveryId}`)
      if (matches.length > 1) throw new Error('Ambiguous delivery build; select an explicit run ID')
      run = matches[0]
      selected = run?.id
    }
    if (run) {
      if (run.head_sha !== commit || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/product-desktop-package.yml') {
        throw new Error('Hosted run does not match the requested desktop source/workflow')
      }
      const state = `${run.id}: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`
      if (state !== previous) { progress(`GitHub build ${state}`); previous = state }
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error(`GitHub build ${run.id} ended with ${run.conclusion}`)
        return run
      }
      if (['action_required', 'waiting'].includes(run.status)) throw new Error(`GitHub build ${run.id} requires attention`)
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
  }
  throw new Error(`Timed out waiting for GitHub build${selected ? ` ${selected}` : ''}; build was not cancelled, retry with its run ID`)
}

/**
 * Stage both destinations before making complete releases visible; retries never replace mismatched assets.
 * @param {object} release Verified release identity and files.
 * @param {object[]} destinations Platform-specific release adapters.
 * @returns {Promise<string[]>} Published download links.
 */
export async function publishDesktopRelease(release, destinations) {
  if (release.prerelease === false) {
    for (const destination of destinations) {
      const latest = await destination.latest()
      if (latest === undefined) continue
      const version = latest.tag_name?.replace(/^v/u, '')
      if (valid(version) === null || gt(version, release.version)) throw new Error(`Refusing to move ${destination.name} update feed backwards`)
    }
  }
  const staged = []
  for (const destination of destinations) {
    let remote = await destination.find(release.tag)
    if (!remote) remote = await destination.create(release)
    if (remote.tag_name !== release.tag || remote.body !== release.body || remote.prerelease !== (release.prerelease ?? true)) {
      throw new Error(`Release identity conflict at ${destination.name}`)
    }
    const expected = new Map(release.files.map(file => [file.name, file]))
    let assets = await destination.assets(remote.id)
    if (assets.some(asset => !expected.has(asset.name)) || new Set(assets.map(asset => asset.name)).size !== assets.length) {
      throw new Error(`Unexpected release assets at ${destination.name}`)
    }
    if (!remote.draft && assets.length !== expected.size) throw new Error(`Published release is incomplete at ${destination.name}`)
    for (const file of release.files) {
      let asset = assets.find(item => item.name === file.name)
      for (let attempt = 0; !asset && attempt < 3; attempt++) {
        try { asset = await destination.upload(remote.id, file) }
        catch (error) {
          if (error.status && error.status < 500 && ![408, 429].includes(error.status)) throw error
          assets = await destination.assets(remote.id)
          asset = assets.find(item => item.name === file.name)
          if (!asset && attempt === 2) throw error
        }
      }
      if (asset.size !== file.size || await destination.hash(asset) !== file.sha256) {
        throw new Error(`Remote asset checksum mismatch at ${destination.name}: ${file.name}`)
      }
    }
    assets = await destination.assets(remote.id)
    if (assets.length !== expected.size || assets.some(asset => !expected.has(asset.name))) {
      throw new Error(`Remote release is incomplete at ${destination.name}`)
    }
    staged.push({ destination, remote })
  }
  const links = []
  for (const { destination, remote } of staged) {
    if (remote.draft) await destination.finalize(remote.id, release)
    const complete = await destination.find(release.tag)
    if (!complete || complete.draft) throw new Error(`Release finalization failed at ${destination.name}`)
    links.push(complete.html_url)
  }
  return links
}
