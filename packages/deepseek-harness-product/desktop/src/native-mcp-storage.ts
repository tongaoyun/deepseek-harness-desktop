/** Employee-scoped MCP state is encrypted by the desktop, never written by Host. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'

const Tables = ['connections', 'grants', 'catalog', 'snapshots', 'governance', 'connection_scopes', 'tool_catalog'] as const
const Request = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read'), employeeId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('put'), employeeId: z.string().min(1), table: z.enum(Tables), key: z.string().min(1).max(512), value: z.unknown() }).strict(),
  z.object({ operation: z.literal('delete'), employeeId: z.string().min(1), table: z.enum(Tables), key: z.string().min(1).max(512) }).strict(),
])
const Document = z.object({ version: z.literal(1), employeeId: z.string(),
  tables: z.record(z.enum(Tables), z.record(z.string(), z.unknown())),
}).strict()
interface SecureStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Main-only persistence; every operation checks the authenticated employee before committing. */
export class NativeMcpStorage {
  constructor(private readonly root: string, private readonly secure: SecureStorage,
    private readonly employee: () => string | undefined) {}

  /** Read or atomically change the current employee's encrypted connector domain.
   * @param payload Untrusted private Host IPC payload.
   * @param signal Host request lifetime.
   * @returns Domain tables for reads, or a committed write acknowledgement.
   */
  async invoke(payload: unknown, signal: AbortSignal): Promise<unknown> {
    const input = Request.parse(payload)
    const check = () => {
      signal.throwIfAborted()
      if (this.employee() !== input.employeeId) throw new Error('MCP employee session changed')
      if (!this.secure.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable')
    }
    check()
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, createHash('sha256').update(input.employeeId).digest('hex') + '.bin')
    return withFileLock(path, async () => {
      check()
      let bytes: Buffer | undefined
      try { bytes = await readFile(path) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const document = Document.parse(bytes === undefined
        ? { version: 1 as const, employeeId: input.employeeId, tables: Object.fromEntries(Tables.map(table => [table, {}])) }
        : JSON.parse(this.secure.decryptString(bytes)))
      if (document.employeeId !== input.employeeId) throw new Error('MCP storage employee mismatch')
      check()
      if (input.operation === 'read') return { tables: document.tables, global: null }
      const records = document.tables[input.table]
      if (records === undefined) throw new Error('MCP storage table is missing')
      if (input.operation === 'put') Object.defineProperty(records, input.key, { value: input.value, enumerable: true, configurable: true, writable: true })
      else Reflect.deleteProperty(records, input.key)
      const serialized = JSON.stringify(document)
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('MCP configuration storage exceeds 32 MiB')
      check()
      await writeFileAtomic(path, this.secure.encryptString(serialized), { mode: 0o600, dirMode: 0o700 })
      return { committed: true }
    }, { signal })
  }
}
