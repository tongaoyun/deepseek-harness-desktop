/** Preserve application bytes and Electron integrity checks in private update qualification copies. */
import assert from 'node:assert/strict'
import { createReadStream, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const desktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const builder = createRequire(desktop.resolve('electron-builder'))
const packager = createRequire(builder.resolve('app-builder-lib'))
const asar = packager('@electron/asar')

/**
 * Copy an ASAR and its unpacked files, replacing only selected qualification inputs.
 * @param {string} source Original private application archive.
 * @param {string} destination Separate output archive beside its unpacked directory.
 * @param {Map<string, Buffer>} replacements Native relative paths and replacement bytes; missing paths are added.
 * Unchanged unpacked resources stream from disk without retaining entire native binaries in memory.
 * @returns {Promise<void>} Resolves after all archived and unpacked output streams finish.
 */
export async function writeUpdateArchive(source, destination, replacements) {
  const pending = new Map(replacements)
  const streams = []
  const add = (path, node, inherited = false) => {
    const unpacked = inherited || node.unpacked === true
    if (node.files) {
      if (path) streams.push({ path, type: 'directory', unpacked })
      for (const [name, child] of Object.entries(node.files)) add(join(path, name), child, unpacked)
    } else if (node.link) {
      streams.push({ path, type: 'link', unpacked, stat: { mode: 0o777 }, symlink: relative(dirname(path), node.link) })
    } else {
      const bytes = pending.get(path)
      pending.delete(path)
      const mode = unpacked ? statSync(join(source + '.unpacked', path)).mode : node.executable ? 0o755 : 0o644
      streams.push({ path, type: 'file', unpacked, stat: { mode, size: bytes?.length ?? node.size },
        streamGenerator: () => bytes !== undefined ? Readable.from([bytes])
          : unpacked ? createReadStream(join(source + '.unpacked', path))
            : Readable.from([asar.extractFile(source, path)]) })
    }
  }
  add('', asar.getRawHeader(source).header)
  for (const [path, bytes] of pending) {
    streams.push({ path, type: 'file', unpacked: false, stat: { mode: 0o644, size: bytes.length },
      streamGenerator: () => Readable.from([bytes]) })
  }
  await finished(await asar.createPackageFromStreams(destination, streams))
}

/**
 * Replace the single existing ASAR hash without removing other executable resources.
 * @param {string} path Private unsigned product executable.
 * @param {string} hash SHA-256 of the rewritten ASAR header.
 * @returns {Promise<void>} Persists the updated executable; missing or ambiguous integrity records fail closed.
 */
export async function rewriteWindowsArchiveIntegrity(path, hash) {
  const { NtExecutable, NtExecutableResource } = await import(pathToFileURL(packager.resolve('resedit')).href)
  const executable = NtExecutable.from(await readFile(path))
  const resource = NtExecutableResource.from(executable)
  const entries = resource.entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')
  assert.equal(entries.length, 1, 'Windows application must have one ASAR integrity resource')
  entries[0].bin = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }]))
  resource.outputResource(executable)
  await writeFile(path, Buffer.from(executable.generate()))
}
