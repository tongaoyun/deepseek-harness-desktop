/** Employee-scoped suspended knowledge edits retain their original write identity in this window. */
import { useEffect, useRef, useState } from 'react'
import { productApi } from './product-api.ts'
import { knowledgeDocument, type KnowledgeDocument } from './knowledge-data.ts'
import { ProductError } from '@deepseek-harness/product/errors'

/** Content and request retained until the original save has a confirmed result. */
export interface KnowledgeSaveDraft {
  readonly title: string
  readonly content: string
  readonly url: string
  readonly parentId: string | null
  readonly metadata?: KnowledgeDocument
  readonly save: { readonly method: string; readonly payload: Readonly<Record<string, unknown>> }
}

const prefix = 'product.knowledge.suspended.v1.'

function parse(value: string): KnowledgeSaveDraft {
  const row: unknown = JSON.parse(value)
  if (typeof row !== 'object' || row === null || !('title' in row) || typeof row.title !== 'string'
    || !('content' in row) || typeof row.content !== 'string' || !('url' in row) || typeof row.url !== 'string'
    || !('parentId' in row) || !(row.parentId === null || typeof row.parentId === 'string')
    || !('save' in row) || typeof row.save !== 'object' || row.save === null
    || !('method' in row.save) || typeof row.save.method !== 'string'
    || !['knowledge.bases.create', 'knowledge.folders.create', 'knowledge.folders.rename',
      'knowledge.documents.importUrl', 'knowledge.documents.save'].includes(row.save.method)
    || !('payload' in row.save) || typeof row.save.payload !== 'object' || row.save.payload === null
    || Array.isArray(row.save.payload) || !('operationId' in row.save.payload) || typeof row.save.payload.operationId !== 'string'
    || Object.values(row.save.payload).some(value => value !== null && typeof value !== 'string')) {
    throw new Error('Invalid suspended knowledge save')
  }
  return { title: row.title, content: row.content, url: row.url, parentId: row.parentId,
    ...'metadata' in row && row.metadata !== undefined ? { metadata: knowledgeDocument(row.metadata) } : {},
    save: { method: row.save.method, payload: row.save.payload } }
}

class KnowledgeSaveRecovery {
  private key: string | undefined
  constructor(private readonly scope: string) {}
  private async identify(): Promise<string> {
    const session = await productApi()?.getSession()
    if (session?.authenticated !== true || !session.employeeId) throw new Error('Employee identity is unavailable')
    return this.key = `${prefix}${encodeURIComponent(session.employeeId)}.${this.scope}`
  }
  async read(): Promise<KnowledgeSaveDraft | undefined> {
    const key = await this.identify()
    const value = sessionStorage.getItem(key)
    return value === null ? undefined : parse(value)
  }
  async suspend(draft: KnowledgeSaveDraft, signal: AbortSignal): Promise<void> {
    const key = await this.identify()
    signal.throwIfAborted()
    sessionStorage.setItem(key, JSON.stringify(draft))
  }
  clear(): void {
    if (this.key === undefined) return
    try { sessionStorage.removeItem(this.key) }
    catch (_error) { throw new ProductError('KNOWLEDGE_SAVE_RECOVERY_FAILED', 'Cannot clear the original save receipt', true) }
  }
}

/** Restore a suspended edit before enabling a new write in the same library and action.
 * @param scope Resource and action identity, excluding editable values.
 * @returns Loaded draft, recovery failure, and employee-bound suspension commands.
 */
export function useKnowledgeSaveRecovery(scope: string) {
  const [recovery] = useState(() => new KnowledgeSaveRecovery(scope))
  const [state, setState] = useState<{ ready: boolean; draft?: KnowledgeSaveDraft; error?: unknown }>(() => ({
    ready: !Object.keys(sessionStorage).some(key => key.startsWith(prefix)),
  }))
  const lifetime = useRef(true)
  const load = async () => {
    try {
      const draft = await recovery.read()
      if (lifetime.current) setState({ ready: true, ...draft === undefined ? {} : { draft } })
    } catch (error) { if (lifetime.current) setState({ ready: false, error }) }
  }
  useEffect(() => {
    lifetime.current = true
    if (!state.ready) void load()
    return () => { lifetime.current = false }
  }, [recovery])
  return { ...state, recovery, reload: load }
}
