/** Employee-owned installation records, separate from immutable task content. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProductContentIdentity, ProductInstalledExpertKits } from '@deepseek-harness/product/protocol'
import { ProductError } from '@deepseek-harness/product/errors'
import { z } from 'zod'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import type { TaskContent } from './tasks.ts'

interface Dependencies {
  readonly root: string
  readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>
  readonly prepare: (id: string, signal?: AbortSignal, installed?: ProductContentIdentity, taskId?: string) => Promise<TaskContent>
}

const identifier = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/)
const identity = z.object({
  id: identifier, name: z.string().optional(), version: z.string().min(1).max(128),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict().transform(entry => ({ id: entry.id, version: entry.version, sha256: entry.sha256,
  ...entry.name === undefined ? {} : { name: entry.name } }))
const installations = z.array(identity).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length)
const MAX_CATALOG_BYTES = 8 * 1024 * 1024

/** Register installations without selecting a task or collecting pinned content.
 * @param ctx Runtime owner, which waits for installation operations on release.
 * @param deps Private account access, durable storage, and validated content preparation.
 * @returns Serialized installation, task-content preparation, inspection, and removal.
 */
export function createInstalledExpertKits(ctx: Context, deps: Dependencies) {
  let operations: Promise<unknown> = Promise.resolve()
  let closed = false
  const assertOpen = () => { if (closed) throw new Error('Expert kit installer has been disposed') }
  const serialize = <T>(operation: () => Promise<T>) => {
    const pending = operations.then(() => { assertOpen(); return operation() })
    operations = pending.catch(() => undefined)
    return pending
  }
  ctx.effect(() => async () => { closed = true; await operations }, 'product-installed-expert-kits.operations')
  const account = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const session = await deps.product.invoke('auth.getSession', undefined, signal)
    if (typeof session !== 'object' || session === null || !('authenticated' in session) || session.authenticated !== true
      || !('employeeId' in session) || typeof session.employeeId !== 'string' || session.employeeId === '') {
      throw new Error('Installed expert kits require an authenticated employee')
    }
    return createHash('sha256').update(session.employeeId).digest('hex')
  }
  const pathFor = (employee: string) => join(deps.root, `installed-${employee}.json`)
  const read = async (employee: string): Promise<ProductContentIdentity[]> => {
    const path = pathFor(employee)
    try {
      if ((await stat(path)).size > MAX_CATALOG_BYTES) throw new Error('Installed expert kit catalog is too large')
      return installations.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }
  const confirmAccount = async (employee: string, signal?: AbortSignal) => {
    if (await account(signal) !== employee) throw new Error('Employee changed during expert kit operation')
    assertOpen()
    signal?.throwIfAborted()
  }
  const save = async (employee: string, entries: readonly ProductContentIdentity[], signal?: AbortSignal) => {
    const encoded = JSON.stringify(entries)
    if (Buffer.byteLength(encoded) > MAX_CATALOG_BYTES) throw new Error('Installed expert kit catalog is too large')
    await mkdir(deps.root, { recursive: true, mode: 0o700 })
    const target = pathFor(employee)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, encoded, { mode: 0o600, signal })
      signal?.throwIfAborted()
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }) }
  }
  const preparedIdentity = (id: string, content: TaskContent): ProductContentIdentity => {
    const entry = identity.parse(content.identity)
    if (entry.id !== id) throw new Error('Expert kit installation identity mismatch')
    return entry
  }
  return {
    prepare(id: string, signal?: AbortSignal, taskId?: string): Promise<TaskContent> {
      return serialize(async () => {
        identifier.parse(id)
        const employee = await account(signal)
        const installed = (await read(employee)).find(entry => entry.id === id)
        if (installed === undefined) throw new ProductError('KIT_NOT_INSTALLED', 'Install this expert kit before selecting it', false,
          [{ kind: 'expert-kit', id }])
        const content = await deps.prepare(id, signal, installed, taskId)
        const entry = preparedIdentity(id, content)
        if (entry.version !== installed.version || entry.sha256 !== installed.sha256) {
          throw new ProductError('KIT_INSTALLED_VERSION_CHANGED', 'Install the current expert kit version before selecting it', false,
            [{ kind: 'expert-kit', id }])
        }
        await confirmAccount(employee, signal)
        return content
      })
    },
    install(id: string, signal?: AbortSignal): Promise<ProductContentIdentity> {
      return serialize(async () => {
        identifier.parse(id)
        const employee = await account(signal)
        const content = await deps.prepare(id, signal)
        const entry = preparedIdentity(id, content)
        const previous = await read(employee)
        await confirmAccount(employee, signal)
        const entries = [...previous.filter(value => value.id !== id), entry].sort((left, right) => left.id.localeCompare(right.id))
        await save(employee, entries, signal)
        return entry
      })
    },
    uninstall(id: string, signal?: AbortSignal): Promise<{ id: string }> {
      return serialize(async () => {
        identifier.parse(id)
        const employee = await account(signal)
        const previous = await read(employee)
        await confirmAccount(employee, signal)
        await save(employee, previous.filter(entry => entry.id !== id), signal)
        return { id }
      })
    },
    read(signal?: AbortSignal): Promise<ProductInstalledExpertKits> {
      return serialize(async () => {
        const employee = await account(signal)
        const installed = await read(employee)
        await confirmAccount(employee, signal)
        return { installed }
      })
    },
  }
}
