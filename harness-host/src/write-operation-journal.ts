import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { HarnessError, data as errorData } from './errors.js'

export class UncertainOperationError extends HarnessError {
  constructor(readonly operationId: string, detail: string) {
    super(errorData('XY-OPERATION-UNCERTAIN', 'connector', '外部操作结果待核对', `${detail}；记录 ${operationId.slice(0, 12)}。请先查询服务端结果，禁止换参数重复提交。`, false, false))
    this.name = 'UncertainOperationError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('工具参数不是有效 JSON')
  return encoded
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

interface OperationRow { id: string; state: string; receipt: string | null }

/** Claim is committed before dispatch; a crash never turns an unknown write into a retry. */
export class WriteOperationJournal {
  private readonly db: DatabaseSync
  constructor(path: string, private readonly scope: string | (() => string)) {
    if (!scope) throw new Error('写操作缺少执行标识')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, signature TEXT NOT NULL, scope TEXT NOT NULL,
        connector TEXT NOT NULL, tool TEXT NOT NULL, state TEXT NOT NULL,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, receipt TEXT, review_note TEXT
      );
      CREATE INDEX IF NOT EXISTS operations_signature ON operations(signature);`)
  }

  /** Runs exactly one already-approved Harness dispatch. This method never
   * talks to MCP directly; `call` is the next `tools/execute` listener. */
  async execute(connector: { id: string; name: string; url: string; command: string; arguments: string[] }, tool: string,
    args: unknown, call: () => Promise<ToolExecutionResult>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    signal?.throwIfAborted()
    const signature = digest([connector.id, connector.url, connector.command, connector.arguments, tool, args])
    const scope = typeof this.scope === 'function' ? this.scope() : this.scope
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(scope)) throw new Error('写操作缺少有效执行标识')
    const id = digest([signature, scope])
    this.db.exec('BEGIN IMMEDIATE')
    let cached: OperationRow | undefined
    try {
      const uncertain = this.db.prepare("SELECT id, state, receipt FROM operations WHERE signature=? AND state='started' LIMIT 1").get(signature) as OperationRow | undefined
      if (uncertain) throw new UncertainOperationError(uncertain.id, '相同写操作的结果仍待核对，已阻止重复提交')
      cached = this.db.prepare('SELECT id, state, receipt FROM operations WHERE id=?').get(id) as OperationRow | undefined
      if (!cached || cached.state === 'released') {
        if (!cached && Number(this.db.prepare('SELECT count(*) AS count FROM operations').get()?.count ?? 0) >= 5000) throw new Error('任务写操作记录已达上限，请新建任务')
        const now = new Date().toISOString()
        this.db.prepare(`INSERT INTO operations (id, signature, scope, connector, tool, state, started_at, updated_at, receipt) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET state='started', started_at=excluded.started_at, updated_at=excluded.updated_at, receipt=NULL`)
          .run(id, signature, scope, connector.name, tool, now, now)
        cached = undefined
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (cached) {
      if (cached.receipt) return JSON.parse(cached.receipt) as ToolExecutionResult
      throw new UncertainOperationError(id, '该写操作已确认完成，请查询现有成果，不要再次提交')
    }
    try {
      const result = await call()
      if (result.isError) throw new UncertainOperationError(id, '服务返回写操作错误，结果需要核对')
      const receipt = JSON.stringify(result)
      this.db.prepare("UPDATE operations SET state='succeeded', receipt=?, updated_at=? WHERE id=? AND state='started'")
        .run(Buffer.byteLength(receipt) <= 2 * 1024 * 1024 ? receipt : null, new Date().toISOString(), id)
      return result
    } catch (error) {
      if (error instanceof UncertainOperationError) throw error
      throw new UncertainOperationError(id, '写操作没有取得成功回执，结果需要核对')
    }
  }

  close(): void { this.db.close() }
}
