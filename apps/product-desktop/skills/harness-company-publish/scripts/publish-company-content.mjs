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
  return companyContentRelease(value)
}

/** Inspect one native resource and its optional exported edit baseline. */
export async function inspectCompanyContent(directory) {
  const root = resolve(directory)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_DIRECTORY', '内容根目录必须是普通目录。')
  let manifest = {}
  try { manifest = JSON.parse((await ordinaryFile(join(root, '.publication.json'), 8192)).toString('utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
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
    if (entry.name === '.publication.json' || entry.name === '.DS_Store' && entry.isFile()) continue
    if (!['experts', 'skills'].includes(entry.name)) fail('UNEXPECTED_FILE', '根目录只能包含 experts、skills 和导出的 .publication.json。')
    await walk(join(root, entry.name))
  }
  const release = validateRelease({ version: '1.0.0', sha256: contentDigest(files), files })
  if (manifest.baseResources !== undefined && (typeof manifest.baseResources !== 'object' || manifest.baseResources === null
    || Array.isArray(manifest.baseResources) || Object.entries(manifest.baseResources).some(([path, hash]) => {
      return !/^(?:skills|experts)\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(path) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)
    }))) fail('INVALID_MANIFEST', '编辑来源摘要无效，请重新导出资源。')
  if (resourceKeys(files).length > 1) fail('ONE_RESOURCE_REQUIRED', '每次只发布一个技能或专家套件。')
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
        if (['POST', 'DELETE'].includes(init.method) && (response.status >= 500 || response.status === 408)) fail('REQUEST_UNCONFIRMED', '发布请求未得到确定响应，将只读查询当前版本。')
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
      if (result?.success !== true || !Object.hasOwn(result, 'data')) fail(['POST', 'DELETE'].includes(init.method) ? 'REQUEST_UNCONFIRMED' : 'INVALID_RESPONSE', '服务端未返回有效业务结果。')
      return result.data
    } catch (error) {
      if (error instanceof PublicationError) throw error
      fail('REQUEST_UNCONFIRMED', '请求未完成或响应无效，请查询当前版本后确认结果；不要盲目重复发布。')
    }
  }
  const resource = value => {
    if (!value || typeof value.resourceKey !== 'string' || typeof value.sha256 !== 'string' || !value.files) fail('INVALID_RESPONSE', '服务端资源回执无效。')
    const validated = validateRelease({ version: '1.0.0', files: value.files, sha256: value.sha256 })
    if (resourceKeys(validated.files).length !== 1 || resourceKeys(validated.files)[0] !== value.resourceKey) fail('INVALID_RESPONSE', '服务端资源回执不匹配。')
    return { resourceKey: value.resourceKey, files: validated.files, sha256: validated.sha256 }
  }
  return {
    url: config.url,
    current: async () => validateRelease(await request('/api/v1/company-content')),
    publish: async (input, expectedSha256) => resource(await request('/api/v1/admin/company-content/releases', { method: 'POST', body: JSON.stringify({ ...input, expectedSha256 }) })),
    remove: async (resourceKey, expectedSha256) => {
      const value = await request('/api/v1/admin/company-content/resource?' + new URLSearchParams({ resourceKey, expectedSha256 }), { method: 'DELETE' })
      if (value !== true) fail('INVALID_RESPONSE', '服务端删除回执无效。')
    },
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

function resourceKey(path) {
  if (/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(path)) return path
  if (/^experts\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(path)) return path
  if (/^experts\/[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(path)) return 'experts/' + path.split('/').at(-1).slice(0, -3)
  fail('INVALID_RESOURCE', '资源必须是 skills/<名称> 或 experts/<名称>。')
}
function resourceKeys(files) {
  return [...new Set(Object.keys(files).map(path => resourceKey(path.startsWith('skills/') ? path.split('/').slice(0, 2).join('/') : path)))].sort()
}
function selectedFiles(files, resource) {
  const key = resourceKey(resource)
  return Object.fromEntries(Object.entries(files).filter(([path]) => key.startsWith('skills/') ? path.startsWith(key + '/') : path.startsWith('experts/') && path.endsWith('/' + key.slice(8) + '.md')))
}
function resourcePaths(files, resource) {
  const paths = Object.keys(selectedFiles(files, resource))
  if (!paths.length) fail('RESOURCE_NOT_FOUND', '指定的公司资源不存在。')
  return paths
}
function resourceDigest(files, resource) { return contentDigest(selectedFiles(files, resource)) }

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
    await writeFile(join(directory, '.publication.json'), `${JSON.stringify({ baseResources: { [resourceKey(resource)]: resourceDigest(release.files, resource) } })}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { exported: true, version: release.version, sha256: release.sha256, paths }
}

/** Plan one resource independently of unrelated company content. */
export function planPublication(current, incoming, url, removals = []) {
  const baseline = validateRelease(current), update = validateRelease(incoming)
  const keys = [...new Set([...resourceKeys(update.files), ...removals.map(resourceKey)])]
  if (!keys.length) fail('NO_CHANGES', '没有待发布的资源。')
  if (keys.length !== 1) fail('ONE_RESOURCE_REQUIRED', '每次只发布或删除一个技能或专家套件。')
  const key = keys[0], files = selectedFiles(update.files, key), before = selectedFiles(baseline.files, key)
  if (removals.length && Object.keys(files).length) fail('CONTRADICTORY_CHANGE', '同一资源不能同时删除和更新。')
  if (removals.length && !Object.keys(before).length) fail('RESOURCE_NOT_FOUND', '指定的公司资源不存在。')
  const expectedSha256 = Object.keys(before).length ? contentDigest(before) : ''
  const editHash = incoming.baseResources?.[key]
  if (editHash !== undefined && editHash !== expectedSha256) fail('EDIT_CONFLICT', '编辑期间该资源已变化，请重新导出并合并修改。')
  if (Object.keys(before).length && editHash === undefined && !removals.length) fail('RESOURCE_EXISTS', '公司已有同名资源，请先导出后编辑。')
  const sha256 = Object.keys(files).length ? contentDigest(files) : ''
  if (sha256 === expectedSha256) fail('NO_CHANGES', '该资源没有变化。')
  return { schema: 2, server: serverURL(url), resourceKey: key, expectedSha256,
    operation: removals.length ? 'delete' : 'publish', resource: { resourceKey: key, sha256, files }, changes: diffFiles(before, files) }
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
  if (plan?.schema !== 2 || serverURL(plan.server) !== plan.server || resourceKey(plan.resourceKey) !== plan.resourceKey
    || !/^(?:|[a-f0-9]{64})$/u.test(plan.expectedSha256 ?? 'invalid') || !['publish', 'delete'].includes(plan.operation)
    || plan.resource?.resourceKey !== plan.resourceKey || typeof plan.resource.sha256 !== 'string') fail('INVALID_PLAN', '发布计划格式无效。')
  if (plan.operation === 'publish') {
    const value = validateRelease({ version: '1.0.0', sha256: plan.resource.sha256, files: plan.resource.files })
    if (resourceKeys(value.files).length !== 1 || resourceKeys(value.files)[0] !== plan.resourceKey) fail('INVALID_PLAN', '发布计划只能包含一个资源。')
  } else if (plan.resource.sha256 !== '' || Object.keys(plan.resource.files).length) fail('INVALID_PLAN', '删除计划不能包含内容。')
  return plan
}

/** Write once using the target resource's hash, then verify only that resource. */
export async function publishPlan(client, plan) {
  if (plan.server !== client.url) fail('SERVER_MISMATCH', '计划与本机发布配置指向不同服务。')
  const hash = release => {
    const files = selectedFiles(validateRelease(release).files, plan.resourceKey)
    return Object.keys(files).length ? contentDigest(files) : ''
  }
  const before = await client.current()
  if (hash(before) === plan.resource.sha256) return { published: true, alreadyCurrent: true, resourceKey: plan.resourceKey, sha256: plan.resource.sha256 }
  if (hash(before) !== plan.expectedSha256) fail('PUBLICATION_CONFLICT', '该资源已变化；请重新导出并核对，不会自动覆盖。')
  try {
    if (plan.operation === 'delete') await client.remove(plan.resourceKey, plan.expectedSha256)
    else {
      const receipt = await client.publish(plan.resource, plan.expectedSha256)
      if (receipt?.resourceKey !== plan.resourceKey || receipt?.sha256 !== plan.resource.sha256) fail('INVALID_RESPONSE', '发布回执与资源不一致。')
    }
  } catch (error) {
    if (!(error instanceof PublicationError) || error.code !== 'REQUEST_UNCONFIRMED') throw error
    let current
    try { current = await client.current() } catch { fail('REQUEST_UNCONFIRMED', '无法确认发布结果；没有重试写入。') }
    if (hash(current) !== plan.resource.sha256) fail('REQUEST_UNCONFIRMED', '发布结果尚未确认；没有重试写入。')
    return { published: true, recovered: true, resourceKey: plan.resourceKey, sha256: plan.resource.sha256 }
  }
  const after = await client.current()
  if (hash(after) !== plan.resource.sha256) fail('VERSION_NOT_CURRENT', '该资源已被更新，请查询当前内容。')
  return { published: true, resourceKey: plan.resourceKey, sha256: plan.resource.sha256 }
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
    return { valid: true, sha256: release.sha256, fileCount: Object.keys(release.files).length }
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
    return { planned: true, resourceKey: plan.resourceKey, sha256: plan.resource.sha256, expectedSha256: plan.expectedSha256, changes: plan.changes, confirmation }
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
