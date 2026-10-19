import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { rewriteWindowsArchiveIntegrity, writeUpdateArchive } from './native-update-integrity.mjs'

const desktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const builder = createRequire(desktop.resolve('electron-builder'))
const packager = createRequire(builder.resolve('app-builder-lib'))
const asar = packager('@electron/asar')
const { NtExecutable, NtExecutableResource } = await import(pathToFileURL(packager.resolve('resedit')).href)

test('rewrites qualification inputs while retaining nested packed and unpacked application files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-update-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input')
  const dependency = join('dsh', 'node_modules', '@agentclientprotocol', 'sdk')
  await mkdir(join(input, dependency), { recursive: true })
  await writeFile(join(input, 'package.json'), '{"version":"1.0.0"}')
  await writeFile(join(input, dependency, 'LICENSE'), 'Keep the dependency license\n')
  const binary = Buffer.from([0, 255, 1, 128, 2, 3])
  await writeFile(join(input, dependency, 'binding.node'), binary)
  if (process.platform !== 'win32') {
    await chmod(join(input, dependency, 'binding.node'), 0o755)
    await symlink('LICENSE', join(input, dependency, 'license-link'))
  }
  const source = join(root, 'source.asar')
  await asar.createPackageWithOptions(input, source, { unpack: '**/*.node' })
  const before = await readFile(source)
  const destination = join(root, 'qualified.asar')
  const replacements = new Map([
    ['package.json', Buffer.from('{"version":"2.0.0"}')],
    ['internal-update-qualification.mjs', Buffer.from('export const ready = true\n')],
  ])
  await writeUpdateArchive(source, destination, replacements)
  assert.deepEqual(await readFile(source), before)
  assert.equal(replacements.size, 2)
  assert.deepEqual(asar.listPackage(destination).sort(), [...asar.listPackage(source), join('/', 'internal-update-qualification.mjs')].sort())
  assert.equal(asar.extractFile(destination, 'package.json').toString(), '{"version":"2.0.0"}')
  assert.equal(asar.extractFile(destination, join(dependency, 'LICENSE')).toString(), 'Keep the dependency license\n')
  assert.deepEqual(asar.extractFile(destination, join(dependency, 'binding.node')), binary)
  assert.equal(asar.statFile(destination, join(dependency, 'binding.node')).unpacked, true)
  assert.deepEqual(await readFile(join(destination + '.unpacked', dependency, 'binding.node')), binary)
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(destination + '.unpacked', dependency, 'binding.node'))).mode & 0o111, 0o111)
    assert.equal(asar.statFile(destination, join(dependency, 'license-link'), false).link, join(dependency, 'LICENSE'))
    assert.equal(asar.extractFile(destination, join(dependency, 'license-link')).toString(), 'Keep the dependency license\n')
  }
  const next = join(root, 'next.asar')
  await writeUpdateArchive(destination, next, new Map([['internal-update-qualification.mjs', Buffer.from('export const ready = false\n')]]))
  assert.deepEqual(asar.listPackage(next).sort(), asar.listPackage(destination).sort())
  assert.equal(asar.extractFile(next, 'internal-update-qualification.mjs').toString(), 'export const ready = false\n')
  await rm(join(source + '.unpacked', dependency, 'binding.node'))
  await assert.rejects(writeUpdateArchive(source, join(root, 'broken.asar'), replacements), { code: 'ENOENT' })
  assert.deepEqual(await readFile(source), before)
})

test('rewrites one Windows ASAR integrity record and retains unrelated executable resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-pe-integrity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'product.exe')
  const executable = NtExecutable.createEmpty(false)
  const resource = NtExecutableResource.from(executable)
  const integrity = { type: 'INTEGRITY', id: 'ELECTRONASAR', lang: 1033, codepage: 1200, bin: Buffer.from('old hash') }
  resource.entries = [integrity, { type: 'FIXTURE', id: 'preserved', lang: 1033, codepage: 1200, bin: Buffer.from('keep these bytes') }]
  resource.outputResource(executable)
  await writeFile(path, Buffer.from(executable.generate()))
  await rewriteWindowsArchiveIntegrity(path, 'a'.repeat(64))
  const updated = NtExecutableResource.from(NtExecutable.from(await readFile(path)))
  const entries = updated.entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')
  assert.equal(entries.length, 1)
  assert.deepEqual(JSON.parse(Buffer.from(entries[0].bin).toString()), [
    { file: 'resources\\app.asar', alg: 'SHA256', value: 'a'.repeat(64) },
  ])
  assert.equal(Buffer.from(updated.entries.find(entry => entry.type === 'FIXTURE').bin).toString(), 'keep these bytes')
  updated.entries = updated.entries.filter(entry => entry.type !== 'INTEGRITY')
  const missing = NtExecutable.from(await readFile(path))
  updated.outputResource(missing)
  await writeFile(path, Buffer.from(missing.generate()))
  const before = await readFile(path)
  await assert.rejects(rewriteWindowsArchiveIntegrity(path, 'b'.repeat(64)), /one ASAR integrity resource/u)
  assert.deepEqual(await readFile(path), before)
  updated.entries = [integrity, { ...integrity, lang: 1031 }]
  updated.outputResource(missing)
  await writeFile(path, Buffer.from(missing.generate()))
  const ambiguous = await readFile(path)
  await assert.rejects(rewriteWindowsArchiveIntegrity(path, 'b'.repeat(64)), /one ASAR integrity resource/u)
  assert.deepEqual(await readFile(path), ambiguous)
})
