import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectCompanyContent } from '../skills/harness-company-publish/scripts/publish-company-content.mjs'

test('inspects standard native files without publishing or embedding credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'release.json'), JSON.stringify({ version: '1.0.0' }))
  await mkdir(join(root, 'skills/orders'), { recursive: true })
  await writeFile(join(root, 'skills/orders/SKILL.md'), '---\nname: orders\ndescription: Company orders\n---\nUse the configured tools.')
  await mkdir(join(root, 'experts/operations'), { recursive: true })
  await writeFile(join(root, 'experts/operations/orders.md'), '---\nname: 订单专家\ndescription: 处理订单\n---\nUse the order skill.')
  const release = await inspectCompanyContent(root)
  assert.equal(release.version, '1.0.0')
  assert.deepEqual(Object.keys(release.files).sort(), ['experts/operations/orders.md', 'skills/orders/SKILL.md'])
  assert.match(release.sha256, /^[a-f0-9]{64}$/u)
  await symlink(join(root, 'release.json'), join(root, 'skills/orders/private.json'))
  await assert.rejects(inspectCompanyContent(root), /Symbolic links/u)
  await rm(join(root, 'skills/orders/private.json'))
  await writeFile(join(root, 'skills/orders/SKILL.md'), 'no metadata')
  await assert.rejects(inspectCompanyContent(root))
})

// These scenarios run in the existing product CI lane, including standalone installation.
const {
  planPublication, writePublicationPlan, readPublicationPlan, publishPlan,
  publisherClient, loadPublisherConfig, exportCompanyResource, PublicationError,
} = await import('../skills/harness-company-publish/scripts/publish-company-content.mjs')
const { contentDigest } = await import('../skills/harness-company-publish/scripts/company-content-codec.mjs')
const { installPublicationSkill } = await import('../scripts/install-company-content-skill.mjs')
const { readFile, chmod } = await import('node:fs/promises')
const { createServer } = await import('node:http')
const { once } = await import('node:events')
const { spawn } = await import('node:child_process')
const SITE = 'http://127.0.0.1:6206/traefik/deepseek-harness'
const skill = (name, body = 'Use the configured tools.') => `---\nname: ${name}\ndescription: Company ${name}\n---\n${body}`
const expert = body => `---\nname: 订单专家\ndescription: 处理订单\n---\n${body}`
const release = (version, texts) => {
  const files = Object.fromEntries(Object.entries(texts).map(([path, text]) => [path, Buffer.from(text).toString('base64')]))
  return { version, files, sha256: contentDigest(files) }
}
const withBase = (incoming, current, resource) => ({ ...incoming, baseResources: {
  [resource]: contentDigest(Object.fromEntries(Object.entries(current.files).filter(([path]) => path === resource || path.startsWith(`${resource}/`)))),
} })
async function privateRoot(t) {
  const path = await mkdtemp(join(tmpdir(), 'company-publisher-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
async function materialize(path, value) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'release.json'), JSON.stringify({ version: value.version, ...(value.baseResources ? { baseResources: value.baseResources } : {}) }))
  for (const [file, encoded] of Object.entries(value.files)) {
    const target = join(path, file)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, Buffer.from(encoded, 'base64'))
  }
}
async function command(script, args, cwd, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|KEY|COMPANY_CONTENT/u.test(key)))
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
  const [code, signal] = await once(child, 'close')
  clearTimeout(timer)
  assert.equal(timedOut, false)
  assert.equal(signal, null)
  return { code, stdout, stderr }
}

test('merges an updated skill as a complete directory while retaining other company resources', () => {
  const current = release('1.0.0', {
    'skills/orders/SKILL.md': skill('orders', 'Old instructions'),
    'skills/orders/references/stale.txt': 'obsolete',
    'skills/finance/SKILL.md': skill('finance'),
    'experts/operations/orders.md': expert('Existing expert'),
  })
  const incoming = withBase(release('1.0.1', { 'skills/orders/SKILL.md': skill('orders', 'New instructions') }), current, 'skills/orders')
  const plan = planPublication(current, incoming, SITE)
  assert.equal(plan.release.files['skills/finance/SKILL.md'], current.files['skills/finance/SKILL.md'])
  assert.equal(plan.release.files['experts/operations/orders.md'], current.files['experts/operations/orders.md'])
  assert.deepEqual(plan.changes, { added: [], modified: ['skills/orders/SKILL.md'], removed: ['skills/orders/references/stale.txt'], unchanged: 2 })
  assert.equal(plan.baseline.version, '1.0.0')
})

test('standalone publication rejects YAML the native provider cannot load without changing files', async t => {
  const root = await privateRoot(t)
  for (const [index, metadata] of ['description: null', 'description: "unterminated',
    'description: Orders\nextra: one\nextra: two', 'description: Orders\nuserInvocable: true'].entries()) {
    const text = `---\nname: orders\n${metadata}\n---\nUse tools.`
    const content = release('1.0.0', { 'skills/orders/SKILL.md': text })
    const directory = join(root, String(index))
    await materialize(directory, content)
    await assert.rejects(inspectCompanyContent(directory))
    assert.equal(await readFile(join(directory, 'skills/orders/SKILL.md'), 'utf8'), text)
  }
})

test('edits retain their resource baseline and reject concurrent changes to that resource', async t => {
  const root = await privateRoot(t)
  const current = release('1.0.0', { 'skills/orders/SKILL.md': skill('orders'), 'skills/orders/references/release.json': '{"resource":true}' })
  const directory = join(root, 'edit')
  await exportCompanyResource(current, 'skills/orders', directory)
  await writeFile(join(directory, 'skills/orders/SKILL.md'), skill('orders', 'My edit'))
  const manifest = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  manifest.version = '1.0.1'
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest))
  const incoming = await inspectCompanyContent(directory)
  const unrelated = release('1.0.2', { 'skills/orders/SKILL.md': skill('orders'), 'skills/orders/references/release.json': '{"resource":true}', 'skills/finance/SKILL.md': skill('finance') })
  assert.equal(Object.keys(planPublication(unrelated, incoming, SITE).release.files).length, 3)
  const concurrent = release('1.0.2', { 'skills/orders/SKILL.md': skill('orders', 'Somebody else edited') })
  assert.throws(() => planPublication(concurrent, incoming, SITE), { code: 'EDIT_CONFLICT' })
  assert.throws(() => planPublication(null, incoming, SITE), { code: 'EDIT_CONFLICT' })
  await assert.rejects(exportCompanyResource(current, 'skills/orders', directory), { code: 'EEXIST' })
  assert.equal(await readFile(join(directory, 'skills/orders/SKILL.md'), 'utf8'), skill('orders', 'My edit'))
})

test('new resources never implicitly replace same-name company resources', () => {
  const current = release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') })
  assert.throws(() => planPublication(current, release('1.0.1', { 'skills/orders/SKILL.md': skill('orders', 'overwrite') }), SITE), { code: 'RESOURCE_EXISTS' })
})

test('deletion requires a complete named resource and cannot expand from an empty source', () => {
  const current = release('1.0.0', { 'skills/orders/SKILL.md': skill('orders'), 'skills/finance/SKILL.md': skill('finance') })
  const empty = release('1.0.1', {})
  assert.throws(() => planPublication(current, empty, SITE), { code: 'NO_CHANGES' })
  const plan = planPublication(current, empty, SITE, ['skills/orders'])
  assert.deepEqual(Object.keys(plan.release.files), ['skills/finance/SKILL.md'])
  for (const path of ['skills/*', '../skills/orders', 'skills/orders/SKILL.md']) assert.throws(() => planPublication(current, empty, SITE, [path]), { code: 'INVALID_RESOURCE' })
  assert.throws(() => planPublication(current, empty, SITE, ['skills/missing']), { code: 'RESOURCE_NOT_FOUND' })
  assert.deepEqual(planPublication(current, empty, SITE, ['skills/orders', 'skills/finance']).release.files, {})
})

test('same version changes, cross-category expert collisions and file-directory collisions are rejected', () => {
  const current = release('1.0.0', { 'experts/operations/orders.md': expert('Old') })
  assert.throws(() => planPublication(current, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE), { code: 'VERSION_REQUIRED' })
  assert.throws(() => planPublication(current, release('1.0.1', { 'experts/finance/orders.md': expert('New') }), SITE))
  assert.throws(() => planPublication(null, release('1.0.1', { 'skills/orders/SKILL.md': skill('orders'), 'skills/orders/path': 'file', 'skills/orders/path/child': 'child' }), SITE), /文件与目录路径冲突/u)
  assert.throws(() => planPublication(null, release('1.0.1', { 'skills/orders/SKILL.md': skill('orders'),
    'skills/orders/Assets/one.txt': 'one', 'skills/orders/assets/two.txt': 'two' }), SITE), /目录大小写冲突/u)
})

test('plans cannot be overwritten or used after bytes have changed', async t => {
  const root = await privateRoot(t)
  const plan = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  const path = join(root, 'plan.json')
  const hash = await writePublicationPlan(path, plan)
  assert.deepEqual(await readPublicationPlan(path, hash), plan)
  await assert.rejects(writePublicationPlan(path, plan), { code: 'EEXIST' })
  if (process.platform !== 'win32') assert.equal((await (await import('node:fs/promises')).stat(path)).mode & 0o777, 0o600)
  await writeFile(path, `${await readFile(path, 'utf8')} `)
  await assert.rejects(readPublicationPlan(path, hash), { code: 'PLAN_CHANGED' })
})

test('preflight conflict or a different configured server sends no write', async () => {
  const plan = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  let reads = 0, writes = 0
  const client = { url: SITE, current: async () => { reads++; return release('1.0.1', {}) }, publish: async () => { writes++ } }
  await assert.rejects(publishPlan({ ...client, url: 'https://other.invalid' }, plan), { code: 'SERVER_MISMATCH' })
  assert.equal(reads, 0)
  await assert.rejects(publishPlan(client, plan), { code: 'PUBLICATION_CONFLICT' })
  assert.equal(writes, 0)
})

test('successful publication is verified and an exact repeated plan sends no additional write', async () => {
  const plan = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  let current = release('0.0.0', {}), writes = 0
  current.version = '0'
  const client = { url: SITE, current: async () => current, publish: async (candidate, expected) => { assert.equal(expected, '0'); writes++; current = candidate; return candidate } }
  assert.equal((await publishPlan(client, plan)).published, true)
  assert.equal((await publishPlan(client, plan)).alreadyCurrent, true)
  assert.equal(writes, 1)
})

test('a committed write with a lost reply is recovered by reading without another POST', async () => {
  const plan = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  let current = { version: '0', sha256: contentDigest({}), files: {} }, writes = 0
  const client = { url: SITE, current: async () => current, publish: async candidate => { writes++; current = candidate; throw new PublicationError('REQUEST_UNCONFIRMED', 'timeout') } }
  assert.equal((await publishPlan(client, plan)).recovered, true)
  assert.equal(writes, 1)
  current = { version: '0', sha256: contentDigest({}), files: {} }
  client.publish = async () => { writes++; throw new PublicationError('REQUEST_UNCONFIRMED', 'timeout') }
  await assert.rejects(publishPlan(client, plan), { code: 'REQUEST_UNCONFIRMED' })
  assert.equal(writes, 2)
})

test('an old idempotent release receipt is not reported as the current version', async () => {
  const plan = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  let reads = 0
  const client = { url: SITE, current: async () => ++reads === 1 ? { version: '0', sha256: contentDigest({}), files: {} } : release('2.0.0', {}), publish: async () => plan.release }
  await assert.rejects(publishPlan(client, plan), { code: 'VERSION_NOT_CURRENT' })
})

test('configuration keeps server and token together and enforces private file permissions', async t => {
  const root = await privateRoot(t)
  const path = join(root, 'private.json')
  const values = { COMPANY_CONTENT_SERVER_URL: SITE, COMPANY_CONTENT_PUBLISHER_TOKEN: 'dummy-publisher-not-real' }
  await writeFile(path, JSON.stringify(values), { mode: 0o600 })
  assert.deepEqual(await loadPublisherConfig(path, { COMPANY_CONTENT_SERVER_URL: 'https://unrelated.invalid' }), { url: SITE, token: values.COMPANY_CONTENT_PUBLISHER_TOKEN })
  await assert.rejects(loadPublisherConfig(undefined, { COMPANY_CONTENT_SERVER_URL: SITE }), { code: 'CONFIG_REQUIRED' })
  for (const url of ['https://user:pass@example.invalid', 'file:///private', 'https://example.invalid/?token=abc']) await assert.rejects(loadPublisherConfig(undefined, { ...values, COMPANY_CONTENT_SERVER_URL: url }))
  if (process.platform !== 'win32') {
    await chmod(path, 0o644)
    await assert.rejects(loadPublisherConfig(path, {}), { code: 'CONFIG_PERMISSIONS' })
  }
})

test('API failures do not disclose body credentials and redirects cannot forward them', async () => {
  const token = 'dummy-secret-should-not-appear'
  const observed = []
  const config = { url: SITE, token }
  const client = publisherClient(config, async (url, options) => {
    observed.push({ url, options })
    return new Response(`${token} upstream error`, { status: 403 })
  })
  await assert.rejects(client.current(), error => error.code === 'PUBLICATION_DENIED' && !error.message.includes(token))
  assert.equal(observed[0].options.redirect, 'error')
  assert.equal(observed[0].options.headers['X-DeepSeek-Harness-Company-Publisher-Token'], token)
  const invalid = publisherClient(config, async () => Response.json({ success: true, data: { version: token } }))
  await assert.rejects(invalid.current())
})

test('local source rejects unexpected root files, path conflicts and linked directories', async t => {
  const root = await privateRoot(t)
  const directory = join(root, 'source')
  await materialize(directory, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }))
  await writeFile(join(directory, '.env'), 'NOT_A_REAL_SECRET=example')
  await assert.rejects(inspectCompanyContent(directory), { code: 'UNEXPECTED_FILE' })
  await rm(join(directory, '.env'))
  await symlink(join(directory, 'skills'), join(directory, 'experts'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectCompanyContent(directory), { code: 'INVALID_DIRECTORY' })
})

test('standalone skill runs outside the workspace, publishes through real HTTP and contains no credentials', async t => {
  const root = await privateRoot(t)
  const installation = join(root, 'standalone-skill')
  await installPublicationSkill(installation)
  await assert.rejects(installPublicationSkill(installation))
  await installPublicationSkill(installation, true)
  const tool = join(installation, 'scripts/publish-company-content.mjs')
  const source = join(root, 'source')
  await materialize(source, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }))
  let current = null, writes = 0
  const token = 'only-for-this-test'
  const server = createServer(async (req, res) => {
    if (req.headers['x-deepseek-harness-company-publisher-token'] !== token) { res.writeHead(401).end(); return }
    const payload = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data })) }
    if (req.method === 'GET' && req.url === '/api/v1/company-content') { payload(current); return }
    if (req.method !== 'POST' || req.url !== '/api/v1/admin/company-content/releases') { res.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const candidate = JSON.parse(body)
    writes++
    if (candidate.expectedVersion !== (current?.version ?? '0')) { res.writeHead(409).end(); return }
    current = { version: candidate.version, sha256: candidate.sha256, files: candidate.files }
    payload(current)
  })
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const config = join(root, 'credential.json')
  await writeFile(config, JSON.stringify({ COMPANY_CONTENT_SERVER_URL: `http://127.0.0.1:${server.address().port}`, COMPANY_CONTENT_PUBLISHER_TOKEN: token }), { mode: 0o600 })
  const checked = await command(tool, ['check', source], root)
  assert.equal(checked.code, 0, checked.stderr)
  const planPath = join(root, 'preview.json')
  const planned = await command(tool, ['plan', source, '--out', planPath, '--config', config], root)
  assert.equal(planned.code, 0, planned.stderr)
  assert.equal(writes, 0)
  const preview = JSON.parse(planned.stdout)
  const args = ['publish', planPath, '--confirm', preview.confirmation, '--config', config]
  const published = await command(tool, args, root)
  assert.equal(published.code, 0, published.stderr)
  assert.equal(JSON.parse(published.stdout).published, true)
  const repeated = await command(tool, args, root)
  assert.equal(repeated.code, 0, repeated.stderr)
  assert.equal(JSON.parse(repeated.stdout).alreadyCurrent, true)
  assert.equal(writes, 1)
  assert.equal(current.sha256, JSON.parse(await readFile(planPath, 'utf8')).release.sha256)
  const status = await command(tool, ['current', '--config', config], root)
  assert.equal(status.code, 0, status.stderr)
  const exported = await command(tool, ['export', 'skills/orders', '--out', join(root, 'exported'), '--config', config], root)
  assert.equal(exported.code, 0, exported.stderr)
  const bad = await command(tool, ['publish', planPath, '--confirm', 'wrong', '--config', config], root)
  assert.equal(bad.code, 1)
  assert.equal(JSON.parse(bad.stderr).code, 'PLAN_CHANGED')
  for (const output of [checked, planned, published, repeated, status, exported, bad]) assert.equal(`${output.stdout}${output.stderr}`.includes(token), false)
  for (const file of ['SKILL.md', 'scripts/publish-company-content.mjs', 'scripts/company-content-codec.mjs']) assert.equal((await readFile(join(installation, file), 'utf8')).includes(token), false)
  assert.equal((await readFile(planPath, 'utf8')).includes(token), false)
})

test('two concurrent publishers cannot both activate plans against the same baseline', async () => {
  const a = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  const b = planPublication(null, release('1.0.1', { 'skills/finance/SKILL.md': skill('finance') }), SITE)
  let reads = 0, unblock
  const ready = new Promise(resolve => { unblock = resolve })
  let current = { version: '0', sha256: contentDigest({}), files: {} }, writes = 0
  const client = { url: SITE,
    current: async () => {
      const value = current
      if (++reads <= 2) { if (reads === 2) unblock(); await ready }
      return value
    },
    publish: async (candidate, expected) => {
      writes++
      if (current.version !== expected) throw new PublicationError('PUBLICATION_CONFLICT', 'race')
      current = candidate
      return candidate
    },
  }
  const results = await Promise.allSettled([publishPlan(client, a), publishPlan(client, b)])
  assert.equal(writes, 2)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PUBLICATION_CONFLICT')
  assert.equal(Object.keys(current.files).length, 1)
})

test('reclassifying an exported expert requires explicit removal and preserves its edit baseline', async t => {
  const root = await privateRoot(t)
  const current = release('1.0.0', { 'experts/operations/orders.md': expert('Original') })
  const incoming = withBase(release('1.0.1', { 'experts/finance/orders.md': expert('Moved') }), current, 'experts/operations/orders.md')
  await materialize(join(root, 'source'), incoming)
  const inspected = await inspectCompanyContent(join(root, 'source'))
  const plan = planPublication(current, inspected, SITE, ['experts/operations/orders.md'])
  assert.deepEqual(Object.keys(plan.release.files), ['experts/finance/orders.md'])
  const concurrent = release('1.0.2', { 'experts/operations/orders.md': expert('Another edit') })
  assert.throws(() => planPublication(concurrent, inspected, SITE, ['experts/operations/orders.md']), { code: 'EDIT_CONFLICT' })
})

test('source limits reject oversized ordinary files before reading their contents', async t => {
  const root = await privateRoot(t)
  await materialize(root, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }))
  const file = await (await import('node:fs/promises')).open(join(root, 'skills/orders/oversized.bin'), 'w')
  try { await file.truncate(32 * 1024 * 1024 + 1) } finally { await file.close() }
  await assert.rejects(inspectCompanyContent(root), { code: 'FILE_TOO_LARGE' })
  const files = { 'skills/orders/SKILL.md': skill('orders') }
  for (let i = 0; i < 2048; i++) files[`skills/orders/references/file-${i}.txt`] = 'x'
  assert.throws(() => planPublication(null, release('1.0.0', files), SITE))
})

test('HTTP 502 after commit is verified by reading and never retried as a write', async () => {
  const plan = planPublication(null, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }), SITE)
  let current = null, writes = 0
  const client = publisherClient({ url: SITE, token: 'dummy' }, async (_url, options) => {
    if (options.method === 'POST') { writes++; current = plan.release; return new Response('upstream unavailable', { status: 502 }) }
    return Response.json({ success: true, data: current })
  })
  assert.equal((await publishPlan(client, plan)).recovered, true)
  assert.equal(writes, 1)
})

test('request timeout covers stalled response bodies and closes the owned connection', async t => {
  let bodyStarted = false
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"success":true,')
    bodyStarted = true
  })
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = publisherClient({ url: `http://127.0.0.1:${server.address().port}`, token: 'dummy' }, fetch, 5_000)
  await assert.rejects(client.current(), { code: 'REQUEST_UNCONFIRMED' })
  assert.equal(bodyStarted, true)
})

test('committed standalone validator matches the product public module', async () => {
  const { synchronizeSkillCodec } = await import('../scripts/sync-company-content-skill.mjs')
  await synchronizeSkillCodec(true)
})

test('a clean sparse checkout installs the skill without node_modules or build output', async t => {
  const root = await privateRoot(t)
  const checkout = join(root, 'clean-checkout')
  const relativeFiles = [
    'scripts/install-company-content-skill.mjs',
    'skills/harness-company-publish/SKILL.md',
    'skills/harness-company-publish/scripts/publish-company-content.mjs',
    'skills/harness-company-publish/scripts/company-content-codec.mjs',
  ]
  for (const path of relativeFiles) {
    const target = join(checkout, 'apps/product-desktop', path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, await readFile(new URL(`../${path}`, import.meta.url)))
  }
  const installer = join(checkout, 'apps/product-desktop/scripts/install-company-content-skill.mjs')
  const target = join(root, 'installed')
  const installed = await command(installer, ['--directory', target], root)
  assert.equal(installed.code, 0, installed.stderr)
  const source = join(root, 'content')
  await materialize(source, release('1.0.0', { 'skills/orders/SKILL.md': skill('orders') }))
  const checked = await command(join(target, 'scripts/publish-company-content.mjs'), ['check', source], root)
  assert.equal(checked.code, 0, checked.stderr)
  assert.equal(JSON.parse(checked.stdout).valid, true)
  const direct = await command(join(checkout, 'apps/product-desktop/skills/harness-company-publish/scripts/publish-company-content.mjs'), ['check', source], root)
  assert.equal(direct.code, 0, direct.stderr)
})
