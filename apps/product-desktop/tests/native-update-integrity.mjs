/** Preserve enabled Electron integrity checks in private Windows update qualification copies. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const desktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const builder = createRequire(desktop.resolve('electron-builder'))
const packager = createRequire(builder.resolve('app-builder-lib'))

/**
 * Replace the single existing ASAR hash without removing other executable resources.
 * @param {string} path Private unsigned product executable.
 * @param {string} hash SHA-256 of the rewritten ASAR header.
 * @returns {Promise<void>} Persists the updated executable; missing or ambiguous integrity records fail closed.
 */
export async function rewriteWindowsArchiveIntegrity(path, hash) {
  const { NtExecutable, NtExecutableResource } = await import(packager.resolve('resedit'))
  const executable = NtExecutable.from(await readFile(path))
  const resource = NtExecutableResource.from(executable)
  const entries = resource.entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')
  assert.equal(entries.length, 1, 'Windows application must have one ASAR integrity resource')
  entries[0].bin = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }]))
  resource.outputResource(executable)
  await writeFile(path, Buffer.from(executable.generate()))
}
