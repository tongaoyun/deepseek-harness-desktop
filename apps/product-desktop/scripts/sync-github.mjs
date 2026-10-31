/** Synchronize the selected desktop commit and stored baseline without changing repository visibility. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { waitForDesktopBuild } from './desktop-release.mjs'
import { apiClient } from './deliver-desktop.mjs'
import { productSigningMode } from './update-release.mjs'

export const PACKAGE_WORKFLOW = '.github/workflows/product-desktop-package.yml'

/** Classify captured Git stderr without returning URLs, headers, credentials or arbitrary remote text. */
export function gitPushFailureCode(error) {
  const diagnostic = String(error.stderr ?? '')
  if (/407|proxy authentication required/iu.test(diagnostic)) return 'PROXY_AUTHENTICATION'
  if (/Authentication failed|403|could not read Username/iu.test(diagnostic)) return 'GITHUB_AUTHORIZATION'
  if (/non-fast-forward|fetch first|would clobber existing tag/iu.test(diagnostic)) return 'REMOTE_REF_CONFLICT'
  if (/SSL_ERROR_SYSCALL|SSL_connect|TLS.*handshake|gnutls_handshake/iu.test(diagnostic)) return 'TLS_HANDSHAKE_FAILED'
  if (/timed? out|ETIMEDOUT/iu.test(diagnostic) || error.code === 'ETIMEDOUT') return 'NETWORK_TIMEOUT'
  if (/Could not resolve|Could not connect|Failed to connect/iu.test(diagnostic)) return 'NETWORK_UNAVAILABLE'
  return error.signal ? 'PROCESS_INTERRUPTED' : 'GIT_PUSH_FAILED'
}

/** @param {string} token Controlled GitHub credential. @param {object} transport Optional isolated test transport. @returns {Function} Complete-read retries and single-attempt mutations. */
export function githubSyncRequest(token, transport = {}) {
  return apiClient('https://api.github.com', `Bearer ${token}`, {
    ...transport, timeoutMs: 30_000,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  }).request
}

// Settings writes are idempotent, but a lost response still requires confirmation before dependent work.
async function reconcileSetting(request, method, path, body, readPath, matches) {
  try { await request(method, path, body) }
  catch (error) {
    if (error.uncertainReleaseMutation !== true) throw error
    const current = await request('GET', readPath).catch(() => { throw error })
    if (!matches(current)) throw error
  }
}

const selectedActions = {
  github_owned_allowed: true, verified_allowed: false,
  patterns_allowed: ['pnpm/action-setup@*', 'dtolnay/rust-toolchain@*'],
}
const settingsMatch = desired => current => Object.entries(desired).every(([key, value]) =>
  Array.isArray(value) ? Array.isArray(current[key]) && [...value].sort().join('\n') === [...current[key]].sort().join('\n')
    : current[key] === value)

/**
 * Keep only product packaging enabled among repository workflow files; GitHub-managed workflows are not configurable here.
 * @param {Function} request Authenticated GitHub API operation.
 * @param {string} repository Validated owner/name.
 * @returns {Promise<void>} Resolves once every discovered workflow has the selected state.
 */
export async function selectPackagingWorkflow(request, repository) {
  const workflows = []
  for (let page = 1; ; page++) {
    const result = await request('GET', `/repos/${repository}/actions/workflows?per_page=100&page=${page}`)
    workflows.push(...result.workflows)
    if (result.workflows.length < 100) break
  }
  const selected = workflows.find(workflow => workflow.path === PACKAGE_WORKFLOW)
  if (!selected) throw new Error('Product packaging workflow has not been indexed; Actions remain disabled, retry synchronization')
  for (const workflow of workflows) {
    if (!workflow.path.startsWith('.github/workflows/')) continue
    if (workflow.id === selected.id) {
      if (workflow.state !== 'active') await reconcileSetting(request, 'PUT', `/repos/${repository}/actions/workflows/${workflow.id}/enable`,
        undefined, `/repos/${repository}/actions/workflows/${workflow.id}`, state => state.state === 'active')
    } else if (workflow.state === 'active') {
      await reconcileSetting(request, 'PUT', `/repos/${repository}/actions/workflows/${workflow.id}/disable`,
        undefined, `/repos/${repository}/actions/workflows/${workflow.id}`, state => state.state === 'disabled_manually')
    }
  }
}

/**
 * Upload changed source with Actions disabled; reconcile settings and dispatch exactly once.
 * @param {object} options Validated source and repository settings.
 * @param {string} options.repository GitHub owner/name.
 * @param {string} options.commit Exact desktop source commit.
 * @param {string} options.tag Stored official baseline tag.
 * @param {string} options.baseline Exact stored baseline commit.
 * @param {boolean} options.create Whether to create a new private repository.
 * @param {string} [options.deliveryId] Correlation ID for the dispatched build.
 * @param {'signed' | 'unsigned' | 'internal'} [options.signing] Distribution mode; omitted retains development packaging.
 * @param {Function} options.request Authenticated API operation.
 * @param {Function} options.push Pushes only main and the baseline, without force or deletion.
 * @returns {Promise<void>} Resolves after GitHub accepts the build dispatch.
 */
export async function synchronizeDesktop({ repository, commit, tag, baseline, create = false, deliveryId, signing, request, push }) {
  productSigningMode(signing)
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Use a GitHub owner/name')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('An exact source commit is required')
  if (!/^[a-f0-9]{40}$/u.test(baseline)) throw new Error('An exact baseline commit is required')
  if (!/^dsh-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(tag)) throw new Error('A pinned Harness baseline tag is required')
  if (deliveryId !== undefined && !/^[a-f0-9-]{36}$/u.test(deliveryId)) throw new Error('A delivery UUID is required')
  if (create) {
    const identity = await request('GET', '/user')
    const [owner, name] = repository.split('/')
    const path = identity.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
    await request('POST', path, { name, private: true, auto_init: false, description: 'Desktop packaging mirror; source of truth is internal Gitea' })
  }
  const metadata = await request('GET', `/repos/${repository}`)
  if (typeof metadata.private !== 'boolean' || metadata.fork === true || metadata.archived === true) {
    throw new Error('Use an active non-fork build repository with known visibility')
  }
  if (metadata.size > 0 && metadata.default_branch !== 'main') throw new Error('Build repository must use main as its default branch')
  const refsMatch = async () => {
    const [head, stored] = await Promise.all([
      request('GET', `/repos/${repository}/git/ref/heads/main`),
      request('GET', `/repos/${repository}/git/ref/tags/${tag}`),
    ])
    const target = stored.object?.type === 'tag'
      ? (await request('GET', `/repos/${repository}/git/tags/${stored.object.sha}`)).object : stored.object
    return head.object?.type === 'commit' && head.object.sha === commit
      && target?.type === 'commit' && target.sha === baseline
  }
  const permissionsPath = `/repos/${repository}/actions/permissions`
  let permissions = await request('GET', permissionsPath)
  let uploaded = false
  if (metadata.size > 0) {
    try { uploaded = await refsMatch() }
    catch (error) { if (error.status !== 404) throw error }
  }
  if (!uploaded) {
    if (permissions.enabled !== false) {
      await reconcileSetting(request, 'PUT', permissionsPath, { enabled: false }, permissionsPath, state => state.enabled === false)
      permissions = { ...permissions, enabled: false }
    }
    try { await push(repository, commit, tag) }
    catch (error) {
      // Atomic upload may have succeeded even when Git lost the response.
      if (!await refsMatch().catch(() => { throw error })) throw error
    }
  }
  if (metadata.default_branch !== 'main' || metadata.has_issues !== false || metadata.has_wiki !== false) {
    const desired = { default_branch: 'main', has_issues: false, has_wiki: false }
    await reconcileSetting(request, 'PATCH', `/repos/${repository}`, desired, `/repos/${repository}`, settingsMatch(desired))
  }
  await selectPackagingWorkflow(request, repository)
  const desired = { enabled: true, allowed_actions: 'selected' }
  if (!settingsMatch(desired)(permissions)) {
    await reconcileSetting(request, 'PUT', permissionsPath, desired, permissionsPath, settingsMatch(desired))
  }
  const policyPath = `${permissionsPath}/selected-actions`
  if (!settingsMatch(selectedActions)(await request('GET', policyPath))) {
    await reconcileSetting(request, 'PUT', policyPath, selectedActions, policyPath, settingsMatch(selectedActions))
  }
  try {
    await request('POST', `/repos/${repository}/actions/workflows/product-desktop-package.yml/dispatches`, {
      ref: 'main', inputs: { source_sha: commit, ...(deliveryId === undefined ? {} : { delivery_id: deliveryId }),
        ...(signing === undefined ? {} : { signing }) },
    })
  } catch (error) {
    if (error.uncertainReleaseMutation !== true || deliveryId === undefined) throw error
    // Confirm the same UUID; never issue a second dispatch after an uncertain response.
    await waitForDesktopBuild({ request, repository, commit, deliveryId, waitForCompletion: false, timeoutMs: 60_000 })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, create: { type: 'boolean', default: false },
    'delivery-id': { type: 'string' }, signing: { type: 'string' } } })
  const repository = values.repository ?? process.env.GITHUB_DESKTOP_REPOSITORY
  if (!repository) throw new Error('Set --repository owner/name or GITHUB_DESKTOP_REPOSITORY')
  const root = resolve(import.meta.dirname, '../../..')
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git(['status', '--porcelain']) !== '') throw new Error('Commit desktop changes before synchronizing')
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    throw new Error('Complete desktop history is required; run git fetch --unshallow origin before synchronizing')
  }
  const commit = git(['rev-parse', 'HEAD'])
  const tag = git(['show', 'HEAD:UPSTREAM_TAG'])
  const baseline = git(['show', 'HEAD:UPSTREAM_COMMIT'])
  if (git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== baseline) throw new Error('Stored Harness baseline does not match the pin')
  let token = process.env.GITHUB_DESKTOP_TOKEN
  if (!token) {
    try { token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
    catch { throw new Error('Log in through gh auth login or configure GITHUB_DESKTOP_TOKEN') }
  }
  const request = githubSyncRequest(token)
  const push = async (destination, source, baselineTag) => {
    const temporary = mkdtempSync(join(tmpdir(), 'harness-github-askpass-'))
    try {
      const askpass = join(temporary, 'askpass.cjs')
      writeFileSync(askpass, '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]?.toLowerCase().includes("username") ? "x-access-token" : process.env.GITHUB_DESKTOP_TOKEN);\n', { mode: 0o700, flag: 'wx' })
      execFileSync('git', ['-c', 'credential.helper=', 'push', '--atomic', `https://github.com/${destination}.git`,
        `${source}:refs/heads/main`, `refs/tags/${baselineTag}:refs/tags/${baselineTag}`], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
        env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', GITHUB_DESKTOP_TOKEN: token },
      })
    } catch (error) {
      const reason = error.signal ? 'process interrupted' : Number.isInteger(error.status) ? `exit ${error.status}` : 'process failed'
      throw new Error(`GitHub atomic push failed (${gitPushFailureCode(error)}, ${reason}). Actions remain disabled unless both remote refs confirm completion; inspect remote main and baseline before retrying`)
    }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }
  try {
    await synchronizeDesktop({ repository, commit, tag, baseline, create: values.create,
      deliveryId: values['delivery-id'] ?? randomUUID(), signing: values.signing, request, push })
    console.log(`Synchronized ${commit}; packages: https://github.com/${repository}/actions/workflows/product-desktop-package.yml`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'GitHub desktop synchronization failed')
    process.exitCode = 1
  }
}
