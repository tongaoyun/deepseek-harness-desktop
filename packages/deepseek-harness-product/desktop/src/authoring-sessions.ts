/** Atomic conversation drafts and original import resources, scoped to an authenticated employee. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExtensionAuthoringSnapshotSchema, ExtensionContentDraftSchema, ExtensionDraftSchema,
  type ExtensionAuthoringSnapshot } from '@deepseek-harness/product/extension-draft'
import { ProductError } from '@deepseek-harness/product/errors'
import { readExtensionDirectory } from './extension-archives.ts'

const MAX_DRAFT_BYTES = 2 * 1024 * 1024

/** Private desktop storage; operations on one draft are serialized across reads, updates and saves. */
export class AuthoringSessions {
  private readonly operations = new Map<string, Promise<unknown>>()
  constructor(private readonly root: string) {}

  /** Serialize one authenticated conversation operation.
   * @param owner Authenticated employee ID.
   * @param sessionId Official Session identity.
   * @param operation Operation held through its final commit.
   * @returns The operation result.
   */
  async using<T>(owner: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.path(owner, sessionId)
    const pending = (this.operations.get(key)?.catch(() => undefined) ?? Promise.resolve()).then(operation)
    this.operations.set(key, pending)
    try { return await pending }
    finally { if (this.operations.get(key) === pending) this.operations.delete(key) }
  }

  /** Wait for accepted operations before releasing the desktop extension. */
  async close(): Promise<void> { await Promise.allSettled([...this.operations.values()]) }

  /** Create a draft and commit imported resources together.
   * @param owner Authenticated employee ID.
   * @param sessionId Preallocated official Session identity.
   * @param draft Initial incomplete content metadata.
   * @param files Validated package resources.
   * @param signal Operation cancellation.
   * @param editing Whether the resource identity and next version are fixed by an existing personal resource.
   * @returns The durable draft preview.
   */
  async begin(owner: string, sessionId: string, draft: ExtensionAuthoringSnapshot['draft'], files: Map<string, Buffer>,
    signal: AbortSignal, editing = false): Promise<ExtensionAuthoringSnapshot> {
    if (await this.read(owner, sessionId, signal)) throw new Error('A creation conversation already exists')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(this.root, '.preparing-'))
    try {
      await mkdir(join(temporary, 'content'), { mode: 0o700 })
      for (const [path, bytes] of files) {
        signal.throwIfAborted()
        const filename = join(temporary, 'content', path)
        await mkdir(join(filename, '..'), { recursive: true, mode: 0o700 })
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600, signal })
      }
      const snapshot = this.preview({ authoringId: randomUUID(), sessionId, revision: 0, draft, editing,
        files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length })), missingFields: [] })
      await writeFile(join(temporary, 'draft.json'), this.encode(snapshot), { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(temporary, this.path(owner, sessionId))
      return snapshot
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }

  /** Read one draft without treating a damaged record as an ordinary conversation.
   * @param owner Authenticated employee ID.
   * @param sessionId Official Session identity.
   * @param signal Operation cancellation.
   * @returns The draft, or null when no creation record exists.
   */
  async read(owner: string, sessionId: string, signal: AbortSignal): Promise<ExtensionAuthoringSnapshot | null> {
    const file = join(this.path(owner, sessionId), 'draft.json')
    let size: number
    try { size = (await stat(file)).size }
    catch (error) { if (isMissing(error)) return null; throw error }
    if (size > MAX_DRAFT_BYTES) throw new Error('Creation draft exceeds size limit')
    return this.preview(ExtensionAuthoringSnapshotSchema.parse(JSON.parse(await readFile(file, { encoding: 'utf8', signal }))))
  }

  /** Commit the next draft revision atomically.
   * @param owner Authenticated employee ID.
   * @param state Validated state with the next revision.
   * @param signal Operation cancellation.
   * @returns The committed preview.
   */
  async write(owner: string, state: ExtensionAuthoringSnapshot, signal: AbortSignal): Promise<ExtensionAuthoringSnapshot> {
    const snapshot = this.preview(state)
    const directory = this.path(owner, snapshot.sessionId)
    const temporary = join(directory, `.draft-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, this.encode(snapshot), { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(temporary, join(directory, 'draft.json'))
      return snapshot
    } finally { await rm(temporary, { force: true }) }
  }

  /** Recover the bounded original package for immutable upload.
   * @param owner Authenticated employee ID.
   * @param sessionId Official Session identity.
   * @param signal Operation cancellation.
   * @returns Validated package resources retained across restarts.
   */
  async files(owner: string, sessionId: string, signal: AbortSignal): Promise<Map<string, Buffer>> {
    return readExtensionDirectory(join(this.path(owner, sessionId), 'content'), signal)
  }

  /** Remove only an unused initial draft after official Session creation fails.
   * @param owner Authenticated employee ID.
   * @param state Initial draft.
   */
  async discard(owner: string, state: ExtensionAuthoringSnapshot): Promise<void> {
    if (state.revision !== 0 || state.saved) throw new Error('An edited creation conversation cannot be discarded')
    await rm(this.path(owner, state.sessionId), { recursive: true, force: true })
  }

  private path(owner: string, sessionId: string): string {
    return join(this.root, createHash('sha256').update(JSON.stringify([owner, sessionId])).digest('hex'))
  }
  private preview(state: ExtensionAuthoringSnapshot): ExtensionAuthoringSnapshot {
    const draft = ExtensionContentDraftSchema.parse(state.draft)
    const result = ExtensionDraftSchema.safeParse(draft)
    return ExtensionAuthoringSnapshotSchema.parse({ ...state, draft,
      missingFields: result.success ? [] : [...new Set(result.error.issues.map(issue => issue.path.join('.')))] })
  }
  private encode(state: ExtensionAuthoringSnapshot): string {
    const text = JSON.stringify(state) + '\n'
    if (Buffer.byteLength(text) > MAX_DRAFT_BYTES) throw new Error('Creation draft exceeds size limit')
    return text
  }
}

/** Reject concurrent updates or saves of a preview that has changed.
 * @param state Current main-owned draft.
 * @param input Untrusted request identity and revision.
 */
export function assertAuthoringRevision(state: ExtensionAuthoringSnapshot | null,
  input: Readonly<Record<string, unknown>>): asserts state is ExtensionAuthoringSnapshot {
  if (!state || state.authoringId !== input.authoringId) throw new ProductError('EXTENSION_OWNER_REQUIRED', 'Creation conversation is unavailable to this employee', false)
  if (state.revision !== input.revision) throw new ProductError('EXTENSION_DRAFT_CHANGED', 'The creation draft changed; refresh its preview', true)
}
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
