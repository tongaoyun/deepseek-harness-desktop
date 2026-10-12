/** Run the internal source, hosted build and two-destination development release pipeline. */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { collectDesktopRelease, extractBuildArchive, publishDesktopRelease, RELEASE_TARGETS, waitForDesktopBuild } from './desktop-release.mjs'

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const root = resolve(import.meta.dirname, '../../..')
const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function response(url, headers, options = {}) {
  const result = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000), duplex: options.body instanceof Readable ? 'half' : undefined })
  if (result.status >= 300 && result.status < 400 && options.download === true) {
    const location = result.headers.get('location')
    await result.body?.cancel()
    const target = location && new URL(location, url)
    const sameOrigin = target && target.origin === new URL(url).origin
    if (!target || !(target.protocol === 'https:' || sameOrigin && target.protocol === 'http:')
      || (options.redirects ?? 0) >= 5) throw new Error('Invalid artifact download redirect')
    // Signed blob downloads never receive repository credentials.
    return response(target.href, sameOrigin ? headers : {}, { download: true, timeoutMs: options.timeoutMs, redirects: (options.redirects ?? 0) + 1 })
  }
  if (!result.ok) {
    await result.body?.cancel()
    const error = new Error(`Release HTTP request failed (${result.status})`)
    error.status = result.status
    throw error
  }
  return result
}

/** @param {string} base API URL. @param {string} authorization Controlled credential. @returns {object} HTTP adapter. */
export function apiClient(base, authorization) {
  const headers = { Authorization: authorization, Accept: 'application/json' }
  return {
    request: async (method, path, body) => {
      const result = await response(base + path, headers, { method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
      return result.status === 204 ? {} : result.json()
    },
    download: async path => (await response(base + path, { ...headers, Accept: 'application/octet-stream' },
      { download: true, timeoutMs: 15 * 60_000 })).body,
    response: (url, options) => {
      const target = new URL(url)
      if (target.origin !== new URL(base).origin && !(base === 'https://api.github.com' && target.origin === 'https://uploads.github.com')) {
        throw new Error('Release transfer cannot forward credentials to another origin')
      }
      return response(url, headers, options)
    },
  }
}

/** @param {string} name Destination label. @param {object} client HTTP adapter. @param {string} repository Owner/repo. @param {object} options API and tag target. @returns {object} Release adapter. */
export function releaseDestination(name, client, repository, { github = false, target, base }) {
  const prefix = `/repos/${repository}/releases`
  return {
    name,
    find: async tag => {
      try { return await client.request('GET', `${prefix}/tags/${encodeURIComponent(tag)}`) }
      catch (error) { if (error.status === 404) return undefined; throw error }
    },
    create: async release => {
      const payload = { tag_name: release.tag, name: `DeepSeek Harness ${release.version}`, body: release.body,
        draft: true, prerelease: true, target_commitish: target }
      try { return await client.request('POST', prefix, payload) }
      catch (error) {
        if (error.status && error.status < 500 && ![409, 422].includes(error.status)) throw error
        const existing = await client.request('GET', `${prefix}/tags/${encodeURIComponent(release.tag)}`)
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
    hash: async asset => {
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
      return hash.digest('hex')
    },
    upload: async (id, file) => {
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
    finalize: id => client.request('PATCH', `${prefix}/${id}`, { draft: false }),
  }
}

async function main() {
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
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Commit all desktop source before delivery')
  const privateRepo = await github.request('GET', `/repos/${repository}`)
  const publicRepo = await github.request('GET', `/repos/${downloads}`)
  const internalRepo = await gitea.request('GET', `/repos/${internal}`)
  if (privateRepo.private !== true || publicRepo.private !== false || !publicRepo.permissions?.push
    || publicRepo.archived || publicRepo.fork || !internalRepo.permissions?.push) throw new Error('Release repository permissions or visibility are invalid')
  if ((await gitea.request('GET', `/repos/${internal}/git/commits/${commit}`)).sha !== commit) {
    throw new Error('Requested source is not stored in Gitea')
  }
  const deadline = Date.now() + 20 * 60_000
  while (true) {
    const result = await gitea.request('GET', `/repos/${internal}/actions/runs?limit=50&page=1`)
    const ci = result.workflow_runs.find(run => run.head_sha === commit && run.event === 'push' && run.path === 'electron-ci.yml@refs/heads/main')
    if (!ci) throw new Error('Exact source main CI is missing')
    if (ci.status === 'completed') {
      if (ci.conclusion !== 'success') throw new Error('Exact source main CI failed; release stopped')
      break
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for exact source main CI')
    await new Promise(resolve => setTimeout(resolve, 15_000))
  }
  const resumed = process.env.DESKTOP_BUILD_RUN_ID?.trim()
  if (resumed && !/^[1-9]\d*$/u.test(resumed)) throw new Error('A numeric GitHub build run ID is required')
  const deliveryId = randomUUID()
  if (!resumed) {
    execFileSync(process.execPath, [join(import.meta.dirname, 'sync-github.mjs'), '--delivery-id', deliveryId], { cwd: root, stdio: 'inherit' })
  }
  const run = await waitForDesktopBuild({ request: github.request, repository, commit, deliveryId,
    runId: resumed ? Number(resumed) : undefined })
  console.log(`Verified successful build: https://github.com/${repository}/actions/runs/${run.id}`)
  const allArtifacts = []
  for (let page = 1; ; page++) {
    const result = await github.request('GET', `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`)
    allArtifacts.push(...result.artifacts)
    if (result.artifacts.length < 100) break
  }
  const stage = await mkdtemp(join(tmpdir(), 'harness-desktop-release-'))
  try {
    for (const target of RELEASE_TARGETS) {
      const name = `harness-${target}-unsigned-${run.run_number}-${run.run_attempt}`
      const matches = allArtifacts.filter(artifact => artifact.name === name && artifact.expired === false)
      if (matches.length !== 1) throw new Error(`Missing or ambiguous hosted artifact: ${target}`)
      await extractBuildArchive(await github.download(`/repos/${repository}/actions/artifacts/${matches[0].id}/zip`), join(stage, target))
    }
    const productVersion = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version
    const release = await collectDesktopRelease(stage, run, commit, productVersion)
    const links = await publishDesktopRelease(release, [
      releaseDestination('Gitea', gitea, internal, { target: commit, base }),
      releaseDestination('GitHub downloads', github, downloads, { github: true, target: publicRepo.default_branch }),
    ])
    console.log(`Published verified unsigned version ${release.version}\n${links.join('\n')}`)
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
