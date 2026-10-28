/** Employee-scoped suspended knowledge edits retain their original write identity in this window. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  private async identify(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const session = await productApi()?.getSession()
    signal.throwIfAborted()
    if (session?.authenticated !== true || !session.employeeId) throw new Error('Employee identity is unavailable')
    return `${prefix}${encodeURIComponent(session.employeeId)}.${this.scope}`
  }
  async read(signal: AbortSignal): Promise<KnowledgeSaveDraft | undefined> {
    const key = await this.identify(signal)
    signal.throwIfAborted()
    const value = sessionStorage.getItem(key)
    const draft = value === null ? undefined : parse(value)
    this.key = key
    return draft
  }
  async suspend(draft: KnowledgeSaveDraft, signal: AbortSignal): Promise<void> {
    const key = await this.identify(signal)
    signal.throwIfAborted()
    sessionStorage.setItem(key, JSON.stringify(draft))
    this.key = key
  }
  clear(): void {
    if (this.key === undefined) return
    try { sessionStorage.removeItem(this.key) }
    catch (_error) { throw new ProductError('KNOWLEDGE_SAVE_RECOVERY_FAILED', 'Cannot clear the original save receipt', true) }
  }
}

interface RecoveryState { readonly ready: boolean; readonly draft?: KnowledgeSaveDraft; readonly error?: unknown }

function initialState(): RecoveryState {
  try { return { ready: !Object.keys(sessionStorage).some(key => key.startsWith(prefix)) } }
  catch (error) { return { ready: false, error } }
}

/** Restore a suspended edit before enabling a new write in the same library and action.
 * Scope replacement and newer retries invalidate earlier reads, including their employee storage key.
 * @param scope Resource and action identity, excluding editable values.
 * @returns Loaded draft or storage/identity failure with explicit retry, and employee-bound suspension commands.
 */
export function useKnowledgeSaveRecovery(scope: string): {
  ready: boolean
  draft?: KnowledgeSaveDraft
  error?: unknown
  recovery: KnowledgeSaveRecovery
  reload: () => Promise<void>
} {
  const owner = useMemo(() => ({ recovery: new KnowledgeSaveRecovery(scope), initial: initialState() }), [scope])
  const [state, setState] = useState(() => ({ owner, value: owner.initial }))
  const active = useRef<{ owner: typeof owner; controller: AbortController } | undefined>(undefined)
  const load = useCallback(async () => {
    if (active.current?.owner !== owner) return
    active.current.controller.abort()
    const controller = new AbortController()
    active.current = { owner, controller }
    setState({ owner, value: { ready: false } })
    try {
      const draft = await owner.recovery.read(controller.signal)
      if (!controller.signal.aborted) setState({ owner, value: { ready: true, ...draft === undefined ? {} : { draft } } })
    } catch (error) {
      if (!controller.signal.aborted) setState({ owner, value: { ready: false, error } })
    }
  }, [owner])
  useEffect(() => {
    active.current = { owner, controller: new AbortController() }
    if (!owner.initial.ready && owner.initial.error === undefined) void load()
    return () => {
      if (active.current?.owner !== owner) return
      active.current.controller.abort()
      active.current = undefined
    }
  }, [owner, load])
  return { ...state.owner === owner ? state.value : owner.initial, recovery: owner.recovery, reload: load }
}
