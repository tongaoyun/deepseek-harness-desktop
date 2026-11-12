/** Bounded AgentSpec ZIP and directory transfer for the expert editor. */
import { unzipSync, zipSync } from 'fflate/browser'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import { createArchivePathValidator } from '@deepseek-harness/product/content-paths'
import { customExpertInputSchema, type CustomExpertInput } from '../expert-contract.ts'
import { expertPackageManifest } from '../package-manifest.ts'

/** Localized package validation failure displayed by the editor. */
export class PackageTransferError extends Error {
  /** Create a localized package transfer error.
   * @param key - Editor translation key.
   * @param options - Original parsing or decompression failure.
   */
  constructor(readonly key: 'custom.packageInvalid' | 'custom.packageTooLarge' | 'custom.instructionsInvalid', options?: ErrorOptions) { super(key, options) }
}
const MAX_BYTES = 32 * 1024 * 1024
const MAX_FILES = 2048
function packagePaths(entries: Record<string, Uint8Array>): Record<string, string> {
  const paths = Object.keys(entries)
  const entry = paths.filter(path => path === 'manifest.json' || path.endsWith('/manifest.json'))
    .sort((left, right) => left.length - right.length)[0]
  if (entry === undefined) throw new PackageTransferError('custom.packageInvalid')
  const prefix = entry.slice(0, -'manifest.json'.length)
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries[entry])) }
  catch (error) { throw new PackageTransferError('custom.packageInvalid', { cause: error }) }
  if (typeof manifest !== 'object' || manifest === null || !('worker' in manifest) || typeof manifest.worker !== 'object' || manifest.worker === null
    || !('suggested_name' in manifest.worker) || typeof manifest.worker.suggested_name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.worker.suggested_name)) throw new PackageTransferError('custom.packageInvalid')
  const files: Record<string, string> = {}
  for (const path of paths) {
    if (!path.startsWith(prefix)) throw new PackageTransferError('custom.packageInvalid')
    files[`experts/${manifest.worker.suggested_name}/${path.slice(prefix.length)}`] = bytesToBase64(entries[path])
  }
  portableFilePaths(Object.keys(files))
  return files
}
function safePath(path: string): void {
  if (path.length > 240 || /[\\\u0000-\u001f:"<>|?*]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))) throw new PackageTransferError('custom.packageInvalid')
}
function packagePathValidator() {
  const validate = createArchivePathValidator(() => { throw new PackageTransferError('custom.packageInvalid') })
  return (entry: { path: string; directory: boolean }): void => {
    safePath(entry.path)
    validate(entry)
  }
}
function portableFilePaths(paths: readonly string[]): void {
  const validate = packagePathValidator()
  for (const path of paths) validate({ path, directory: false })
}
/** Read one ZIP or selected directory with portable filenames, file-count and decompression bounds.
 * Explicit ZIP directories and implicit parents share collision checks; only files are imported.
 * The enclosing manifest owns the package; nested manifests remain resource files.
 * @param selection - User-selected ZIP or package directory.
 * @param signal - Editor lifetime cancellation, checked before reading and after each completed read.
 * @returns Complete base64-encoded package files; incomplete decompression fails, and cancellation stops further reads and processing.
 */
export async function importPackageFiles(selection: readonly File[], signal: AbortSignal): Promise<Record<string, string>> {
  signal.throwIfAborted()
  let total = 0
  const entries = new Map<string, Uint8Array>()
  if (selection.length === 1 && selection[0].name.toLowerCase().endsWith('.zip')) {
    if (selection[0].size > MAX_BYTES) throw new PackageTransferError('custom.packageTooLarge')
    let count = 0, fileCount = 0
    const validatePath = packagePathValidator()
    const bytes = new Uint8Array(await selection[0].arrayBuffer())
    signal.throwIfAborted()
    let unpacked: Record<string, Uint8Array>
    try {
      unpacked = unzipSync(bytes, { filter(info) {
        if (++count > 4096) throw new PackageTransferError('custom.packageTooLarge')
        const directory = info.name.endsWith('/')
        validatePath({ path: directory ? info.name.slice(0, -1) : info.name, directory })
        if (directory) return false
        if (++fileCount > MAX_FILES || (total += info.originalSize) > MAX_BYTES) throw new PackageTransferError('custom.packageTooLarge')
        return true
      } })
    } catch (error) {
      if (error instanceof PackageTransferError) throw error
      throw new PackageTransferError('custom.packageInvalid', { cause: error })
    }
    if (Object.keys(unpacked).length !== fileCount) throw new PackageTransferError('custom.packageInvalid')
    for (const [path, bytes] of Object.entries(unpacked)) entries.set(path, bytes)
  } else {
    if (selection.length > MAX_FILES) throw new PackageTransferError('custom.packageTooLarge')
    const files = selection.map(file => {
      const path = file.webkitRelativePath || file.name
      if ((total += file.size) > MAX_BYTES) throw new PackageTransferError('custom.packageTooLarge')
      return { path, file }
    })
    portableFilePaths(files.map(file => file.path))
    for (const { path, file } of files) {
      signal.throwIfAborted()
      const bytes = new Uint8Array(await file.arrayBuffer())
      signal.throwIfAborted()
      entries.set(path, bytes)
    }
  }
  signal.throwIfAborted()
  return packagePaths(Object.fromEntries(entries))
}
/** Encode bounded instructions without dropping optional AgentSpec fields or binary resources.
 * @param draft - Current editor fields.
 * @returns Complete base64-encoded package files.
 */
export function draftPackageFiles(draft: CustomExpertInput): Record<string, string> {
  if (!customExpertInputSchema.shape.prompt.safeParse(draft.prompt).success
    || !customExpertInputSchema.shape.agents.safeParse(draft.agents).success) throw new PackageTransferError('custom.instructionsInvalid')
  const text = expertPackageManifest(draft.slug ?? `custom-${crypto.randomUUID()}`, draft.description, draft.manifest)
  if (!customExpertInputSchema.shape.manifest.safeParse(text).success) throw new PackageTransferError('custom.packageInvalid')
  const manifest: Record<string, unknown> = JSON.parse(text)
  const worker = manifest.worker
  if (typeof worker !== 'object' || worker === null || !('suggested_name' in worker) || typeof worker.suggested_name !== 'string') throw new PackageTransferError('custom.packageInvalid')
  const root = 'experts/' + worker.suggested_name + '/'
  const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text))
  const files = Object.fromEntries(Object.entries(draft.resources ?? {}).map(([path, value]) => [root + path, value]))
  return { ...files, [root + 'manifest.json']: encode(text), [root + 'config/SOUL.md']: encode(draft.prompt),
    ...draft.agents !== undefined ? { [root + 'config/AGENTS.md']: encode(draft.agents) } : {} }
}
/** Merge portable attachments atomically, counting replacement bytes and the complete package.
 * Duplicate selections, file/directory conflicts and nonportable final paths fail before reading any attachment.
 * @param draft - Current expert fields and resources.
 * @param selection - Files selected for the assets directory.
 * @param signal - Editor lifetime cancellation.
 * @returns Complete replacement resources; callers install only after every read succeeds.
 */
export async function addPackageResources(draft: CustomExpertInput, selection: readonly File[], signal: AbortSignal): Promise<Record<string, string>> {
  const resources = { ...draft.resources }
  const files = draftPackageFiles(draft)
  const root = Object.keys(files).find(path => /^experts\/[^/]+\/manifest\.json$/u.test(path))!.slice(0, -'manifest.json'.length)
  const sizes = new Map(Object.entries(files).map(([path, value]) => [path, base64ByteLength(value)]))
  const selected = new Set<string>()
  for (const file of selection) {
    signal.throwIfAborted()
    const full = root + 'assets/' + file.name, key = full.toLowerCase()
    if (selected.has(key)) throw new PackageTransferError('custom.packageInvalid')
    selected.add(key)
    sizes.set(full, file.size)
  }
  portableFilePaths([...sizes.keys()])
  if (sizes.size > MAX_FILES || [...sizes.values()].reduce((sum, size) => sum + size, 0) > MAX_BYTES) throw new PackageTransferError('custom.packageTooLarge')
  for (const file of selection) {
    signal.throwIfAborted()
    const bytes = new Uint8Array(await file.arrayBuffer())
    signal.throwIfAborted()
    resources['assets/' + file.name] = bytesToBase64(bytes)
  }
  return resources
}
/** Exact decoded length for package size accounting and attachment display.
 * @param value - Canonical base64 file content.
 * @returns Decoded byte length, excluding padding.
 */
export function base64ByteLength(value: string): number {
  return value.length * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}
/** Download a complete AgentSpec ZIP using its existing package identifier, checking final size before decoding or compression.
 * @param files - Complete base64-encoded package files.
 */
export function downloadPackage(files: Record<string, string>): void {
  if (Object.keys(files).length > MAX_FILES
    || Object.values(files).reduce((sum, encoded) => sum + base64ByteLength(encoded), 0) > MAX_BYTES) {
    throw new PackageTransferError('custom.packageTooLarge')
  }
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) => [path.replace(/^experts\//u, ''), Uint8Array.from(atob(value), char => char.charCodeAt(0))]))
  const archive = zipSync(entries)
  const url = URL.createObjectURL(new Blob([new Uint8Array(archive)]))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = Object.keys(entries)[0].split('/')[0] + '.zip'; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
