import { readdir, lstat, open, writeFile, mkdir, rm, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { companyContentRelease, contentDigest, COMPANY_CONTENT_MAX_BYTES } from './company-content-codec.mjs'

const MAX_JSON_BYTES = 48 * 1024 * 1024
const MAX_FILES = 2048
const DEFAULT_CONFIG = join(homedir(), '.config/deepseek-harness/company-content-publisher.json')

/** Safe diagnostics never include response bodies, local file contents or credentials. */
export class PublicationError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function fail(code, message) { throw new PublicationError(code, message) }

/** Read bounded ordinary files without following a final symlink. */
async function ordinaryFile(path, limit) {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) fail('INVALID_FILE', '只接受普通文件，不接受符号链接。')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) fail('FILE_TOO_LARGE', '文件超过允许大小。')
    // A bounded read also limits files that grow after stat().
    const data = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let size = 0
    while (size < data.length) {
      const { bytesRead } = await file.read(data, size, data.length - size, null)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size !== stat.size || (await file.stat()).mtimeMs !== stat.mtimeMs) fail('FILE_CHANGED', '读取期间文件发生变化，请重新校验。')
    return data.subarray(0, size)
  } finally { await file.close() }
}

function validateRelease(value) {
  if (value?.version === '0' && value.sha256 === contentDigest({}) && value.files !== null
    && typeof value.files === 'object' && !Array.isArray(value.files) && Object.keys(value.files).length === 0) return companyContentRelease(null)
  const release = companyContentRelease(value)
  const paths = new Set(Object.keys(release.files).map(path => path.toLowerCase()))
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join('/'))) fail('PATH_CONFLICT', '文件与目录路径冲突。')
    }
  }
  return release
}

/** Inspect an incremental native-content directory; release.json is not published. */
export async function inspectCompanyContent(directory) {
  const root = resolve(directory)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_DIRECTORY', '内容根目录必须是普通目录。')
  const manifest = JSON.parse((await ordinaryFile(join(root, 'release.json'), 8192)).toString('utf8'))
  const files = {}
  let bytes = 0
  const walk = async path => {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_DIRECTORY', '目录不能是符号链接。')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) fail('INVALID_FILE', 'Symbolic links are not supported')
      if (entry.name === '.DS_Store' && entry.isFile()) continue
      if (entry.isDirectory()) { await walk(child); continue }
      if (!entry.isFile()) fail('INVALID_FILE', '只接受普通内容文件。')
      if (Object.keys(files).length >= MAX_FILES) fail('TOO_MANY_FILES', '内容文件过多。')
      const data = await ordinaryFile(child, COMPANY_CONTENT_MAX_BYTES - bytes)
      bytes += data.byteLength
      files[relative(root, child).replaceAll('\\', '/')] = data.toString('base64')
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'release.json' || entry.name === '.DS_Store' && entry.isFile()) continue
    if (!['experts', 'skills'].includes(entry.name)) fail('UNEXPECTED_FILE', '根目录只能包含 release.json、experts 和 skills。')
    await walk(join(root, entry.name))
  }
  const release = validateRelease({ version: manifest.version, sha256: contentDigest(files), files })
  if (manifest.baseResources !== undefined && (typeof manifest.baseResources !== 'object' || manifest.baseResources === null
    || Array.isArray(manifest.baseResources) || Object.entries(manifest.baseResources).some(([path, hash]) => {
      return !validResource(path) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)
    }))) fail('INVALID_MANIFEST', '编辑来源摘要无效，请重新导出资源。')
  return { ...release, baseResources: manifest.baseResources ?? {} }
}

function serverURL(value) {
  if (typeof value !== 'string') fail('CONFIG_REQUIRED', '请配置公司发布服务地址和专用发布凭据。')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('INVALID_CONFIG', '公司发布服务地址无效。')
  return url.href.replace(/\/$/u, '')
}

/** Load URL and credential as one configuration; never mix credentials between servers. */
export async function loadPublisherConfig(path, environment = process.env) {
  let source
  if (path === undefined && (environment.COMPANY_CONTENT_SERVER_URL !== undefined || environment.COMPANY_CONTENT_PUBLISHER_TOKEN !== undefined)) {
    source = environment
  } else {
    const file = path ?? DEFAULT_CONFIG
    let stat
    try { stat = await lstat(file) }
    catch (error) { if (error.code === 'ENOENT') fail('CONFIG_REQUIRED', '未找到本机公司发布配置，请配置受控文件；不要将凭据发送到对话。'); throw error }
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) fail('CONFIG_PERMISSIONS', '发布凭据文件必须属于当前用户且权限为 600。')
    source = JSON.parse((await ordinaryFile(file, 16384)).toString('utf8'))
  }
  const url = serverURL(source?.COMPANY_CONTENT_SERVER_URL)
  const token = source?.COMPANY_CONTENT_PUBLISHER_TOKEN
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/u.test(token)) fail('CONFIG_REQUIRED', '缺少有效的公司专用发布凭据。')
  return { url, token }
}

/** Bounded authenticated requests; the configured URL cannot be overridden by a plan. */
export function publisherClient(config, fetcher = fetch, timeoutMs = 60_000) {
  const request = async (path, init = {}) => {
    try {
      const response = await fetcher(`${config.url}${path}`, {
        ...init, headers: { 'content-type': 'application/json', 'X-DeepSeek-Harness-Company-Publisher-Token': config.token },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (init.method === 'POST' && (response.status >= 500 || response.status === 408)) fail('REQUEST_UNCONFIRMED', '发布请求未得到确定响应，将只读查询当前版本。')
        const code = response.status === 409 ? 'PUBLICATION_CONFLICT' : response.status === 401 || response.status === 403 ? 'PUBLICATION_DENIED' : 'HTTP_ERROR'
        fail(code, `公司发布请求失败（HTTP ${response.status}）。`)
      }
      const reader = response.body?.getReader()
      if (!reader) fail('INVALID_RESPONSE', '服务端响应为空。')
      const chunks = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_JSON_BYTES) { await reader.cancel(); fail('INVALID_RESPONSE', '服务端响应超过大小限制。') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (result?.success !== true || !Object.hasOwn(result, 'data')) fail(init.method === 'POST' ? 'REQUEST_UNCONFIRMED' : 'INVALID_RESPONSE', '服务端未返回有效业务结果。')
      return result.data
    } catch (error) {
      if (error instanceof PublicationError) throw error
      fail('REQUEST_UNCONFIRMED', '请求未完成或响应无效，请查询当前版本后确认结果；不要盲目重复发布。')
    }
  }
  return {
    url: config.url,
    current: async () => validateRelease(await request('/api/v1/company-content')),
    publish: async (release, expectedVersion) => validateRelease(await request('/api/v1/admin/company-content/releases', { method: 'POST', body: JSON.stringify({ ...release, expectedVersion }) })),
  }
}

function diffFiles(before, after) {
  const changes = { added: [], modified: [], removed: [], unchanged: 0 }
  for (const path of Object.keys(after).sort()) {
    if (!Object.hasOwn(before, path)) changes.added.push(path)
    else if (before[path] !== after[path]) changes.modified.push(path)
    else changes.unchanged++
  }
  changes.removed = Object.keys(before).filter(path => !Object.hasOwn(after, path)).sort()
  return changes
}

function validResource(resource) {
  return /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(resource)
    || /^experts\/[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(resource)
}

function resourcePaths(files, resource) {
  if (!validResource(resource)) fail('INVALID_RESOURCE', '资源必须是完整技能目录或专家 Markdown 路径。')
  const matches = Object.keys(files).filter(path => path === resource || path.startsWith(`${resource}/`))
  if (matches.length === 0) fail('RESOURCE_NOT_FOUND', '指定的公司资源不存在。')
  return matches
}

function resourceDigest(files, resource) {
  return contentDigest(Object.fromEntries(resourcePaths(files, resource).map(path => [path, files[path]])))
}

/** Export one validated resource for editing; never overwrite a local directory. */
export async function exportCompanyResource(current, resource, directory) {
  const release = validateRelease(current)
  const paths = resourcePaths(release.files, resource)
  await mkdir(directory, { mode: 0o700 })
  try {
    for (const path of paths) {
      const target = join(directory, path)
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
      await writeFile(target, Buffer.from(release.files[path], 'base64'), { mode: 0o600, flag: 'wx' })
    }
    await writeFile(join(directory, 'release.json'), `${JSON.stringify({ version: release.version, baseResources: { [resource]: resourceDigest(release.files, resource) } })}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { exported: true, version: release.version, sha256: release.sha256, paths }
}

/** Merge whole supplied skills, individual experts and explicit resource removals. */
export function planPublication(current, incoming, url, removals = []) {
  const baseline = validateRelease(current)
  const update = validateRelease(incoming)
  const files = { ...baseline.files }
  for (const [resource, baseHash] of Object.entries(incoming.baseResources ?? {})) {
    const existing = Object.keys(files).some(path => path === resource || path.startsWith(`${resource}/`))
    if (!existing || resourceDigest(files, resource) !== baseHash) fail('EDIT_CONFLICT', '编辑期间该资源已被修改或删除，请重新导出并合并修改。')
  }
  const resources = new Set(Object.keys(update.files).map(path => path.startsWith('skills/') ? path.split('/').slice(0, 2).join('/') : path))
  for (const resource of resources) {
    const existing = Object.keys(files).some(path => path === resource || path.startsWith(`${resource}/`))
    const baseHash = incoming.baseResources?.[resource]
    if (existing && baseHash === undefined) fail('RESOURCE_EXISTS', '公司已有同名资源，请先导出当前资源再修改，避免覆盖他人的内容。')
  }
  for (const resource of removals) {
    if (Object.keys(update.files).some(path => path === resource || path.startsWith(`${resource}/`))) fail('CONTRADICTORY_CHANGE', '同一资源不能同时删除和更新。')
    for (const path of resourcePaths(files, resource)) delete files[path]
  }
  const skills = new Set(Object.keys(update.files).filter(path => path.startsWith('skills/')).map(path => path.split('/')[1]))
  for (const path of Object.keys(files)) if (path.startsWith('skills/') && skills.has(path.split('/')[1])) delete files[path]
  Object.assign(files, update.files)
  const release = validateRelease({ version: update.version, files, sha256: contentDigest(files) })
  if (release.sha256 === baseline.sha256) fail('NO_CHANGES', '公司内容没有变化，无需发布。')
  if (release.version === baseline.version) fail('VERSION_REQUIRED', '内容变化必须使用新的内容版本。')
  return { schema: 1, server: serverURL(url), baseline: { version: baseline.version, sha256: baseline.sha256 }, release, changes: diffFiles(baseline.files, files) }
}

/** The approval digest covers the exact plan bytes, including server and baseline. */
export async function writePublicationPlan(path, plan) {
  const data = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`)
  await writeFile(path, data, { flag: 'wx', mode: 0o600 })
  return createHash('sha256').update(data).digest('hex')
}

export async function readPublicationPlan(path, digest) {
  const data = await ordinaryFile(path, MAX_JSON_BYTES)
  if (!/^[a-f0-9]{64}$/u.test(digest ?? '') || createHash('sha256').update(data).digest('hex') !== digest) fail('PLAN_CHANGED', '发布计划已变化，请重新预览并使用对应摘要。')
  const plan = JSON.parse(data.toString('utf8'))
  if (plan?.schema !== 1 || serverURL(plan.server) !== plan.server
    || typeof plan.baseline?.version !== 'string' || !/^[a-f0-9]{64}$/u.test(plan.baseline?.sha256 ?? '')) fail('INVALID_PLAN', '发布计划格式无效。')
  validateRelease(plan.release)
  return plan
}

/** Publish once against the previewed baseline, then verify the active pointer. */
export async function publishPlan(client, plan) {
  if (plan.server !== client.url) fail('SERVER_MISMATCH', '计划与本机发布配置指向不同服务，未发送请求。')
  const same = release => release.version === plan.release.version && release.sha256 === plan.release.sha256
  const before = await client.current()
  if (same(before)) return { published: true, alreadyCurrent: true, version: before.version, sha256: before.sha256 }
  if (before.version !== plan.baseline.version || before.sha256 !== plan.baseline.sha256) fail('PUBLICATION_CONFLICT', '其他人已发布新内容；请重新生成计划并检查差异，不会自动覆盖。')
  try {
    const receipt = await client.publish(plan.release, plan.baseline.version)
    if (!same(receipt)) fail('INVALID_RESPONSE', '发布回执与候选版本不一致。')
  } catch (error) {
    if (!(error instanceof PublicationError) || error.code !== 'REQUEST_UNCONFIRMED') throw error
    // A timed-out POST may already have committed. Only read; never retry a write.
    let current
    try { current = await client.current() } catch { fail('REQUEST_UNCONFIRMED', '发布结果无法确认，请稍后查询当前版本；不要重新合并或盲目重复发布。') }
    if (!same(current)) fail('REQUEST_UNCONFIRMED', '发布结果尚未确认，请查询当前版本；没有自动重试写入。')
    return { published: true, recovered: true, version: current.version, sha256: current.sha256 }
  }
  const after = await client.current()
  if (!same(after)) fail('VERSION_NOT_CURRENT', '该版本不是当前生效版本，请查询公司内容；不会重新激活旧版本。')
  return { published: true, version: after.version, sha256: after.sha256 }
}

const USAGE = 'check <内容目录> | current [--config 私有文件] | export <资源路径> --out 新目录 [--config 私有文件] | plan <内容目录> --out 计划文件 [--remove 资源路径] [--config 私有文件] | publish <计划文件> --confirm 摘要 [--config 私有文件]'

function argumentsFor(args) {
  const [command, ...rest] = args
  if (!['check', 'current', 'export', 'plan', 'publish'].includes(command)) fail('USAGE', USAGE)
  const allowed = { check: [], current: ['--config'], export: ['--config', '--out'], plan: ['--config', '--out', '--remove'], publish: ['--config', '--confirm'] }[command]
  const options = { removals: [] }
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    if (!allowed.includes(arg) || !rest[i + 1] || rest[i + 1].startsWith('--')) fail('USAGE', USAGE)
    const value = rest[++i]
    if (arg === '--remove') options.removals.push(value)
    else {
      const key = arg.slice(2)
      if (Object.hasOwn(options, key)) fail('USAGE', USAGE)
      options[key] = value
    }
  }
  if (positional.length !== (command === 'current' ? 0 : 1) || ['plan', 'export'].includes(command) && !options.out || command === 'publish' && !options.confirm) fail('USAGE', USAGE)
  return { command, path: positional[0], ...options }
}

async function main() {
  const args = argumentsFor(process.argv.slice(2))
  if (args.command === 'check') {
    const release = await inspectCompanyContent(args.path)
    return { valid: true, version: release.version, sha256: release.sha256, fileCount: Object.keys(release.files).length }
  }
  const config = await loadPublisherConfig(args.config)
  const client = publisherClient(config)
  if (args.command === 'current') {
    const current = await client.current()
    return { version: current.version, sha256: current.sha256, paths: Object.keys(current.files).sort() }
  }
  if (args.command === 'export') return exportCompanyResource(await client.current(), args.path, args.out)
  if (args.command === 'plan') {
    const incoming = await inspectCompanyContent(args.path)
    const plan = planPublication(await client.current(), incoming, config.url, args.removals)
    const confirmation = await writePublicationPlan(args.out, plan)
    return { planned: true, version: plan.release.version, baselineVersion: plan.baseline.version, changes: plan.changes, confirmation }
  }
  return publishPlan(client, await readPublicationPlan(args.path, args.confirm))
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    const safe = error instanceof PublicationError ? error : new PublicationError('INVALID_CONTENT_OR_CONFIG', '内容、计划或本机配置无效，请检查文件和原生格式；未输出文件内容及凭据。')
    console.error(JSON.stringify({ success: false, code: safe.code, message: safe.message }))
    process.exitCode = 1
  })
}
