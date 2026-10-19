import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { rewriteWindowsArchiveIntegrity } from './native-update-integrity.mjs'

const desktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const builder = createRequire(desktop.resolve('electron-builder'))
const packager = createRequire(builder.resolve('app-builder-lib'))
const { NtExecutable, NtExecutableResource } = await import(pathToFileURL(packager.resolve('resedit')).href)

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
