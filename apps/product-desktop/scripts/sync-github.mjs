/** Synchronize the selected desktop commit and stored baseline to a private build repository. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

export const PACKAGE_WORKFLOW = '.github/workflows/product-desktop-package.yml'

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
      if (workflow.state !== 'active') await request('PUT', `/repos/${repository}/actions/workflows/${workflow.id}/enable`)
    } else if (workflow.state === 'active') {
      await request('PUT', `/repos/${repository}/actions/workflows/${workflow.id}/disable`)
    }
  }
}

/**
 * Disable Actions before uploading source; enable only the selected workflow after upload.
 * @param {object} options Validated source and repository settings.
 * @param {string} options.repository GitHub owner/name.
 * @param {string} options.commit Exact desktop source commit.
 * @param {string} options.tag Stored official baseline tag.
 * @param {boolean} options.create Whether to create a new private repository.
 * @param {Function} options.request Authenticated API operation.
 * @param {Function} options.push Pushes only main and the baseline, without force or deletion.
 * @returns {Promise<void>} Resolves after GitHub accepts the build dispatch.
 */
export async function synchronizeDesktop({ repository, commit, tag, create = false, request, push }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Use a GitHub owner/name')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('An exact source commit is required')
  if (!/^dsh-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(tag)) throw new Error('A pinned Harness baseline tag is required')
  if (create) {
    const identity = await request('GET', '/user')
    const [owner, name] = repository.split('/')
    const path = identity.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
    await request('POST', path, { name, private: true, auto_init: false, description: 'Private desktop packaging mirror; source of truth is internal Gitea' })
  }
  const metadata = await request('GET', `/repos/${repository}`)
  if (metadata.private !== true || metadata.fork === true || metadata.archived === true) {
    throw new Error('Use an active private non-fork build repository')
  }
  if (metadata.size > 0 && metadata.default_branch !== 'main') throw new Error('Build repository must use main as its default branch')
  await request('PUT', `/repos/${repository}/actions/permissions`, { enabled: false })
  await push(repository, commit, tag)
  await request('PATCH', `/repos/${repository}`, { default_branch: 'main', has_issues: false, has_wiki: false })
  await selectPackagingWorkflow(request, repository)
  await request('PUT', `/repos/${repository}/actions/permissions`, { enabled: true, allowed_actions: 'selected' })
  await request('PUT', `/repos/${repository}/actions/permissions/selected-actions`, {
    github_owned_allowed: true, verified_allowed: false,
    patterns_allowed: ['pnpm/action-setup@*', 'dtolnay/rust-toolchain@*'],
  })
  await request('POST', `/repos/${repository}/actions/workflows/product-desktop-package.yml/dispatches`, {
    ref: 'main', inputs: { source_sha: commit },
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, create: { type: 'boolean', default: false } } })
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
  const request = async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`)
    return response.status === 204 ? {} : response.json()
  }
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
      const diagnostic = error.stderr?.toString().replaceAll(token, '[REDACTED]').slice(-2000).trim()
      throw new Error(`GitHub push failed${diagnostic ? `: ${diagnostic}` : ''}. Actions remain disabled`)
    }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }
  try {
    await synchronizeDesktop({ repository, commit, tag, create: values.create, request, push })
    console.log(`Synchronized ${commit}; packages: https://github.com/${repository}/actions/workflows/product-desktop-package.yml`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'GitHub desktop synchronization failed')
    process.exitCode = 1
  }
}
