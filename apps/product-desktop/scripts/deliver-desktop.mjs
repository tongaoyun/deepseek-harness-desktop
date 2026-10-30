/** Run the internal source, hosted build and two-destination development release pipeline. */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { collectDesktopRelease, desktopPackageAttempts, extractBuildArchive, mapReleaseWork, publishDesktopRelease, RELEASE_TARGETS, waitForDesktopBuild } from './desktop-release.mjs'
import { productSigningMode } from './update-release.mjs'

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const root = resolve(import.meta.dirname, '../../..')
const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'])

function networkFailure(error) {
  const pending = [error]
  const codes = new Set()
  let timeout = false
  let transportError = false
  for (let count = 0; pending.length && count < 16; count++) {
    const current = pending.shift()
    if (!current || typeof current !== 'object') continue
    if (transientCodes.has(current.code)) codes.add(current.code)
    if (current.name === 'TimeoutError') timeout = true
    if (current instanceof TypeError && current.message === 'fetch failed') transportError = true
    pending.push(current.cause)
    if (current instanceof AggregateError) pending.push(...current.errors)
  }
  const status = error?.status
  return { retryable: timeout || codes.size > 0 || transportError
    || [408, 429, 500, 502, 503, 504].includes(status),
  detail: status ? `HTTP ${status}` : timeout ? 'TIMEOUT' : [...codes].join(', ') || 'NETWORK_ERROR' }
}

/**
 * Retry complete, repeatable reads only; report safe codes rather than credential-bearing exception text.
 * @param {Function} operation Complete read operation, including body consumption.
 * @param {object} options Safe label and optional test transport timing.
 * @returns {Promise<unknown>} Completed read result.
 */
export async function retryReleaseRead(operation, { label, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  progress = console.warn } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (error) {
      const failure = networkFailure(error)
      if (!failure.retryable) throw error
      if (attempt === 3) {
        const exhausted = new Error(`${label} failed after 4 attempts (${failure.detail})`, { cause: error })
        exhausted.status = error.status
        exhausted.retryableReleaseRead = true
        throw exhausted
      }
      progress(`${label} retry ${attempt + 1}/3 (${failure.detail})`)
      await sleep(1000 * 2 ** attempt)
    }
  }
}

async function response(url, headers, options = {}) {
  const { fetchImpl = fetch, ...requestOptions } = options
  let result
  try {
    result = await fetchImpl(url, { ...requestOptions, headers: { ...headers, ...options.headers }, redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000), duplex: options.body instanceof Readable ? 'half' : undefined })
  } catch (error) {
    throw new Error(`Release transfer ${options.method ?? 'GET'} ${new URL(url).host} failed (${networkFailure(error).detail})`, { cause: error })
  }
  if (result.status >= 300 && result.status < 400 && options.download === true) {
    const location = result.headers.get('location')
    await result.body?.cancel()
    const target = location && new URL(location, url)
    const sameOrigin = target && target.origin === new URL(url).origin
    if (!target || !(target.protocol === 'https:' || sameOrigin && target.protocol === 'http:')
      || (options.redirects ?? 0) >= 5) throw new Error('Invalid artifact download redirect')
    // Signed blob downloads never receive repository credentials.
    return response(target.href, sameOrigin ? headers : {}, { download: true, fetchImpl, timeoutMs: options.timeoutMs, redirects: (options.redirects ?? 0) + 1 })
  }
  if (!result.ok) {
    await result.body?.cancel()
    const error = new Error(`Release HTTP request failed (${result.status})`)
    error.status = result.status
    throw error
  }
  return result
}

/** @param {string} base API URL. @param {string} authorization Controlled credential. @param {object} transport Optional isolated test transport. @returns {object} HTTP adapter with selectable download media type. */
export function apiClient(base, authorization, transport = {}) {
  const headers = { Accept: 'application/json', ...transport.headers, Authorization: authorization }
  return {
    request: async (method, path, body) => {
      const operation = async () => {
        const result = await response(base + path, headers, { method, fetchImpl: transport.fetchImpl, timeoutMs: transport.timeoutMs,
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
        try { return result.status === 204 ? {} : await result.json() }
        catch (error) {
          if (error instanceof SyntaxError) throw new Error('Invalid release API JSON response', { cause: error })
          throw error
        }
      }
      const label = `Release ${method} ${new URL(base).host}${path.split('?')[0]}`
      if (method === 'GET') return retryReleaseRead(operation, { ...transport, label })
      try { return await operation() }
      catch (error) {
        if (!networkFailure(error).retryable) throw error
        throw new Error(`${label} failed (${networkFailure(error).detail}); reconcile before retrying`, { cause: error })
      }
    },
    download: async (path, { accept = 'application/octet-stream' } = {}) => (await response(base + path, { ...headers, Accept: accept },
      { download: true, fetchImpl: transport.fetchImpl, timeoutMs: 15 * 60_000 })).body,
    response: (url, options) => {
      const target = new URL(url)
      if (target.origin !== new URL(base).origin && !(base === 'https://api.github.com' && target.origin === 'https://uploads.github.com')) {
        throw new Error('Release transfer cannot forward credentials to another origin')
      }
      return response(url, headers, { fetchImpl: transport.fetchImpl, ...options })
    },
  }
}

/** @param {string} name Destination label. @param {object} client HTTP adapter. @param {string} repository Owner/repo. @param {object} options API and tag target. @returns {object} Release adapter. */
export function releaseDestination(name, client, repository, { github = false, target, base, staged = false }) {
  if (staged && !github) throw new Error('Only hosted GitHub drafts support digest verification')
  const prefix = `/repos/${repository}/releases`
  const find = async tag => {
    try { return await client.request('GET', `${prefix}/tags/${encodeURIComponent(tag)}`) }
    catch (error) { if (error.status !== 404) throw error }
    if (!github) return undefined
    const matches = []
    for (let page = 1; ; page++) {
      const rows = await client.request('GET', `${prefix}?per_page=50&page=${page}`)
      matches.push(...rows.filter(release => release.tag_name === tag))
      if (rows.length < 50) break
    }
    if (matches.length > 1) throw new Error(`Ambiguous release drafts at ${name}`)
    return matches[0]
  }
  return {
    name,
    requireStaged: staged,
    find,
    latest: async () => {
      try { return await client.request('GET', `${prefix}/latest`) }
      catch (error) { if (error.status !== 404) throw error }
    },
    create: async release => {
      const payload = { tag_name: release.tag, name: `DeepSeek Harness ${release.version}`, body: release.body,
        draft: true, prerelease: release.prerelease ?? true, target_commitish: target,
        ...(github ? { make_latest: 'false' } : {}) }
      try { return await client.request('POST', prefix, payload) }
      catch (error) {
        if (error.status && error.status < 500 && ![409, 422].includes(error.status)) throw error
        const existing = await find(release.tag)
        if (!existing) throw error
        return existing
      }
    },
    assets: async id => {
      const assets = []
      for (let page = 1; ; page++) {
        const rows = await client.request('GET', `${prefix}/${id}/assets?${github ? 'per_page' : 'limit'}=50&page=${page}`)
        assets.push(...rows)
        if (rows.length < 50) return assets
      }
    },
    recoverAsset: async (remote, asset) => {
      if (staged && asset.state !== 'uploaded') throw new Error(`Hosted draft asset is incomplete at ${name}`)
      if (!github || asset.state === 'uploaded') return asset
      if (remote.draft !== true || asset.state !== 'starter' || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
        throw new Error(`Incomplete release asset at ${name}: ${asset.name}`)
      }
      const path = `${prefix}/assets/${asset.id}`
      const current = await client.request('GET', path)
      if (current.id !== asset.id || current.name !== asset.name) throw new Error(`Release asset identity changed at ${name}`)
      if (current.state === 'uploaded') return current
      if (current.state !== 'starter') throw new Error(`Unexpected release asset state at ${name}`)
      await client.request('DELETE', path)
      return undefined
    },
    hash: asset => retryReleaseRead(async () => {
      console.log(`Verifying ${name} release asset: ${asset.name}`)
      if (github && !/^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? '')) throw new Error(`Missing hosted asset SHA-256 at ${name}`)
      if (staged) {
        return asset.digest.slice(7)
      }
      const chunks = github ? await client.download(`${prefix}/assets/${asset.id}`)
        : (await client.response(asset.browser_download_url, { download: true, timeoutMs: 15 * 60_000 })).body
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of chunks) {
        size += chunk.length
        if (size > asset.size) throw new Error('Remote release asset exceeds declared size')
        hash.update(chunk)
      }
      if (size !== asset.size) throw new Error('Remote release asset is truncated')
      const computed = hash.digest('hex')
      if (github && asset.digest !== `sha256:${computed}`) throw new Error('Hosted asset digest differs from downloaded bytes')
      return computed
    }, { label: `${name} asset verification` }),
    upload: async (id, file) => {
      console.log(`Uploading ${name} release asset: ${file.name}`)
      let url
      let headers
      let body
      if (github) {
        url = `https://uploads.github.com${prefix}/${id}/assets?name=${encodeURIComponent(file.name)}`
        headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }
        body = createReadStream(file.path)
      } else {
        url = `${base}${prefix}/${id}/assets`
        const boundary = `harness-${randomUUID()}`
        const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
        body = Readable.from((async function* () { yield head; yield* createReadStream(file.path); yield tail })())
        headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + file.size + tail.length) }
      }
      try { return await (await client.response(url, { method: 'POST', body, headers, timeoutMs: 15 * 60_000 })).json() }
      finally { body.destroy() }
    },
    finalize: (id, release) => client.request('PATCH', `${prefix}/${id}`, { draft: false,
      ...(github ? { make_latest: release?.prerelease === false ? 'true' : 'false' } : {}) }),
  }
}

/** @param {object} client Download adapter. @param {string} path Artifact API path. @param {string} directory Private staging directory. @param {object} options Read retry timing. @returns {Promise<void>} Complete extracted archive. */
export async function stageBuildArchive(client, path, directory, options = {}) {
  await retryReleaseRead(async () => {
    await rm(directory, { recursive: true, force: true })
    await extractBuildArchive(await client.download(path, { accept: 'application/vnd.github+json' }), directory)
  }, { ...options, label: 'Hosted artifact download' })
}

/**
 * Download only the latest successful execution of each platform, then verify all installer bytes and metadata.
 * May run inside the final hosted job after preflight and every package job have succeeded.
 * @param {object} client Hosted API adapter.
 * @param {string} repository Build repository.
 * @param {object} run Exact hosted workflow identity.
 * @param {string} directory Private staging directory.
 * @param {string} commit Requested source.
 * @param {string} productVersion Source desktop version.
 * @param {object} options Signing mode, download repository and certificate pin.
 * @returns {Promise<object>} Verified immutable release.
 */
export async function downloadDesktopRelease(client, repository, run, directory, commit, productVersion, options) {
  if (run.head_sha !== commit || !['in_progress', 'completed'].includes(run.status)
    || run.status === 'completed' && run.conclusion !== 'success') throw new Error('Exact successful desktop packages are required')
  const packageAttempts = await desktopPackageAttempts(client.request, repository, run, options.signing)
  const artifacts = []
  for (let page = 1; ; page++) {
    const result = await client.request('GET', `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`)
    artifacts.push(...result.artifacts)
    if (result.artifacts.length < 100) break
  }
  const selected = RELEASE_TARGETS.map(target => {
    const name = `harness-${target}-${options.signing}-${run.run_number}-${packageAttempts[target]}`
    const matches = artifacts.filter(artifact => artifact.name === name)
    if (matches.length !== 1 || matches[0].expired !== false || !Number.isSafeInteger(matches[0].id)
      || matches[0].id <= 0 || matches[0].workflow_run?.id !== run.id || matches[0].workflow_run?.head_sha !== commit) {
      throw new Error(`Missing or ambiguous hosted artifact: ${target}`)
    }
    return { target, artifact: matches[0] }
  })
  await mapReleaseWork(selected, async ({ target, artifact }) => {
    console.log(`Downloading verified build target: ${target} (attempt ${packageAttempts[target]})`)
    await stageBuildArchive(client, `/repos/${repository}/actions/artifacts/${artifact.id}/zip`, join(directory, target))
  })
  return collectDesktopRelease(directory, { ...run, status: 'completed', conclusion: 'success' }, commit, productVersion,
    { ...options, packageAttempts })
}

async function main() {
  const signing = productSigningMode(process.env.DESKTOP_SIGNING)
  const repository = required('GITHUB_DESKTOP_REPOSITORY')
  const downloads = required('GITHUB_DOWNLOAD_REPOSITORY')
  const internal = required('GITEA_REPOSITORY')
  if (![repository, downloads, internal].every(value => repoPattern.test(value)) || repository === downloads) {
    throw new Error('Distinct build and download repositories are required')
  }
  const base = required('GITEA_API_URL').replace(/\/$/u, '')
  process.env.GITEA_API_URL = base
  const giteaUrl = new URL(base)
  if (!['http:', 'https:'].includes(giteaUrl.protocol) || giteaUrl.username || giteaUrl.password || giteaUrl.search || giteaUrl.hash) {
    throw new Error('Invalid Gitea API URL')
  }
  const github = apiClient('https://api.github.com', `Bearer ${required('GITHUB_DESKTOP_TOKEN')}`)
  const gitea = apiClient(base, process.env.GITEA_TOKEN
    ? `token ${process.env.GITEA_TOKEN}` : `Basic ${Buffer.from(`${required('GITEA_USERNAME')}:${required('GITEA_PASSWORD')}`).toString('base64')}`)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const commit = process.env.DESKTOP_SOURCE_SHA?.trim() || head
  const resumed = process.env.DESKTOP_BUILD_RUN_ID?.trim()
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('An exact desktop source commit is required')
  if (resumed && !/^[1-9]\d*$/u.test(resumed)) throw new Error('A numeric GitHub build run ID is required')
  if (commit !== head && !resumed) throw new Error('Different delivery code is allowed only when resuming an exact build')
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Commit all desktop source before delivery')
  const buildRepo = await github.request('GET', `/repos/${repository}`)
  const publicRepo = await github.request('GET', `/repos/${downloads}`)
  const internalRepo = await gitea.request('GET', `/repos/${internal}`)
  if (typeof buildRepo.private !== 'boolean' || buildRepo.archived || buildRepo.fork || !buildRepo.permissions?.push
    || publicRepo.private !== false || !publicRepo.permissions?.push
    || publicRepo.archived || publicRepo.fork || !internalRepo.permissions?.push) throw new Error('Release repository permissions or visibility are invalid')
  if ((await gitea.request('GET', `/repos/${internal}/git/commits/${commit}`)).sha !== commit) {
    throw new Error('Requested source is not stored in Gitea')
  }
  const deadline = Date.now() + 20 * 60_000
  for (const source of new Set([head, commit])) {
    while (true) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for exact source main CI')
      let result
      try { result = await gitea.request('GET', `/repos/${internal}/actions/runs?limit=50&page=1`) }
      catch (error) {
        if (error.retryableReleaseRead !== true) throw error
        console.warn('Source CI status temporarily unavailable; continuing within the original deadline')
        await new Promise(resolve => setTimeout(resolve, Math.min(15_000, Math.max(0, deadline - Date.now()))))
        continue
      }
      const ci = result.workflow_runs.find(run => run.head_sha === source && run.event === 'push' && run.path === 'electron-ci.yml@refs/heads/main')
      if (!ci) throw new Error('Exact source main CI is missing')
      if (ci.status === 'completed') {
        if (ci.conclusion !== 'success') throw new Error('Exact source main CI failed; release stopped')
        break
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for exact source main CI')
      await new Promise(resolve => setTimeout(resolve, 15_000))
    }
  }
  console.log(`Delivery code ${head}; desktop source ${commit}`)
  const deliveryId = randomUUID()
  if (!resumed) {
    execFileSync(process.execPath, [join(import.meta.dirname, 'sync-github.mjs'), '--delivery-id', deliveryId,
      '--signing', signing], { cwd: root, stdio: 'inherit' })
  }
  const run = await waitForDesktopBuild({ request: github.request, repository, commit, deliveryId,
    runId: resumed ? Number(resumed) : undefined })
  console.log(`Verified successful build: https://github.com/${repository}/actions/runs/${run.id}`)
  const stage = await mkdtemp(join(tmpdir(), 'harness-desktop-release-'))
  try {
    const productVersion = JSON.parse(execFileSync('git', ['show', `${commit}:apps/desktop/package.json`],
      { cwd: root, encoding: 'utf8' })).version
    const release = await downloadDesktopRelease(github, repository, run, stage, commit, productVersion, { signing, downloadRepository: downloads,
      internalCertificateSHA256: process.env.DESKTOP_INTERNAL_CERTIFICATE_SHA256 })
    const links = await publishDesktopRelease(release, [
      releaseDestination('Gitea', gitea, internal, { target: commit, base }),
      releaseDestination('GitHub downloads', github, downloads, { github: true, target: publicRepo.default_branch, staged: true }),
    ])
    console.log(`Published verified ${signing} version ${release.version}\n${links.join('\n')}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Desktop Downloads\n\nVersion: ${release.version}\n\nSource: ${commit}\n\n${links.map(url => `- ${url}`).join('\n')}\n`)
    }
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try { await main() }
  catch (error) { console.error(error instanceof Error ? error.message : 'Desktop delivery failed'); process.exitCode = 1 }
}
