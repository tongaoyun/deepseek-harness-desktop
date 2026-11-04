/** Bounded AgentSpec ZIP and directory transfer for the expert editor. */
import { unzipSync, zipSync } from 'fflate'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { CustomExpertInput } from '../expert-contract.ts'

/** Localized package validation failure displayed by the editor. */
export class PackageTransferError extends Error {
  /** Create a localized package transfer error.
   * @param key - Editor translation key.
   */
  constructor(readonly key: 'custom.packageInvalid' | 'custom.packageTooLarge') { super(key) }
}
const MAX_BYTES = 32 * 1024 * 1024
function packagePaths(entries: Record<string, Uint8Array>): Record<string, string> {
  const paths = Object.keys(entries)
  const manifests = paths.filter(path => path === 'manifest.json' || path.endsWith('/manifest.json'))
  if (manifests.length !== 1) throw new PackageTransferError('custom.packageInvalid')
  const prefix = manifests[0].slice(0, -'manifest.json'.length)
  const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries[manifests[0]]))
  if (typeof manifest !== 'object' || manifest === null || !('worker' in manifest) || typeof manifest.worker !== 'object' || manifest.worker === null
    || !('suggested_name' in manifest.worker) || typeof manifest.worker.suggested_name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.worker.suggested_name)) throw new PackageTransferError('custom.packageInvalid')
  const files: Record<string, string> = {}
  for (const path of paths) {
    if (!path.startsWith(prefix)) throw new PackageTransferError('custom.packageInvalid')
    files[`experts/${manifest.worker.suggested_name}/${path.slice(prefix.length)}`] = bytesToBase64(entries[path])
  }
  return files
}
function safePath(path: string): void {
  if (path.length > 240 || /[\\\u0000-\u001f:]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new PackageTransferError('custom.packageInvalid')
}
/** Read one ZIP or selected directory with file-count and decompression bounds.
 * @param selection - User-selected ZIP or package directory.
 * @returns Complete base64-encoded package files.
 */
export async function importPackageFiles(selection: FileList): Promise<Record<string, string>> {
  let total = 0
  const entries: Record<string, Uint8Array> = {}
  if (selection.length === 1 && selection[0].name.toLowerCase().endsWith('.zip')) {
    if (selection[0].size > MAX_BYTES) throw new PackageTransferError('custom.packageTooLarge')
    let count = 0
    const seen = new Set<string>()
    const unpacked = unzipSync(new Uint8Array(await selection[0].arrayBuffer()), { filter(info) {
      if (++count > 4096) throw new PackageTransferError('custom.packageTooLarge')
      if (info.name.endsWith('/')) return false
      safePath(info.name)
      if (seen.has(info.name.toLowerCase()) || (total += info.originalSize) > MAX_BYTES) throw new PackageTransferError('custom.packageTooLarge')
      seen.add(info.name.toLowerCase())
      return true
    } })
    Object.assign(entries, unpacked)
  } else {
    if (selection.length > 2048) throw new PackageTransferError('custom.packageTooLarge')
    for (const file of Array.from(selection)) {
      const path = file.webkitRelativePath || file.name
      safePath(path)
      if ((total += file.size) > MAX_BYTES || Object.hasOwn(entries, path)) throw new PackageTransferError('custom.packageTooLarge')
      entries[path] = new Uint8Array(await file.arrayBuffer())
    }
  }
  return packagePaths(entries)
}
/** Encode the current draft without dropping optional AgentSpec fields or binary resources.
 * @param draft - Current editor fields.
 * @returns Complete base64-encoded package files.
 */
export function draftPackageFiles(draft: CustomExpertInput): Record<string, string> {
  const manifest: Record<string, unknown> = draft.manifest ? JSON.parse(draft.manifest) as Record<string, unknown>
    : { worker: { suggested_name: draft.slug ?? `custom-${crypto.randomUUID()}` }, description: draft.description }
  const worker = manifest.worker
  if (typeof worker !== 'object' || worker === null || !('suggested_name' in worker) || typeof worker.suggested_name !== 'string') throw new PackageTransferError('custom.packageInvalid')
  const root = 'experts/' + worker.suggested_name + '/'
  const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text))
  const files = Object.fromEntries(Object.entries(draft.resources ?? {}).map(([path, value]) => [root + path, value]))
  return { ...files, [root + 'manifest.json']: encode(draft.manifest && manifest.description === draft.description ? draft.manifest : JSON.stringify({ ...manifest, description: draft.description }, null, 2)), [root + 'config/SOUL.md']: encode(draft.prompt),
    ...draft.agents ? { [root + 'config/AGENTS.md']: encode(draft.agents) } : {} }
}
/** Download a complete AgentSpec ZIP using its existing package identifier.
 * @param files - Complete base64-encoded package files.
 */
export function downloadPackage(files: Record<string, string>): void {
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) => [path.replace(/^experts\//u, ''), Uint8Array.from(atob(value), char => char.charCodeAt(0))]))
  const archive = zipSync(entries)
  const url = URL.createObjectURL(new Blob([new Uint8Array(archive)]))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = Object.keys(entries)[0].split('/')[0] + '.zip'; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
