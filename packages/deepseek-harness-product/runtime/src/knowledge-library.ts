/** Explicit task-result saving through the product server and official tool approval. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import type { ProductRuntimeMethod } from '@deepseek-harness/product/protocol'

export const name = 'product-knowledge-library'
export const inject = ['tools']
/** Main-owned transport; employee credentials remain outside the Host. */
export interface Config { readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'> }

/** Register metadata discovery and an approved Markdown save operation.
 * @param ctx Product runtime context.
 * @param config Main-process transport.
 */
export function apply(ctx: Context, config: Config): void {
  const lifecycle = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const invoke = (method: ProductRuntimeMethod, payload: unknown, signal: AbortSignal) => {
    const combined = AbortSignal.any([signal, lifecycle.signal])
    combined.throwIfAborted()
    const operation = config.product.invoke(method, payload, combined)
    pending.add(operation)
    return operation.finally(() => { pending.delete(operation) })
  }
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Knowledge library unloaded'))
    await Promise.allSettled([...pending])
  }, 'product-knowledge-library.requests')
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'knowledge_save'
    ? { kind: 'ask', reason: 'Save this task result as a searchable knowledge document.',
      displayReason: { en: 'Save this content to the knowledge base?', 'zh-CN': '将这份内容保存到知识库吗？' } }
    : next())
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_destinations',
    description: 'List knowledge base names and ownership available for explicitly saving a task result. Does not read documents or change the task retrieval selection.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args, result) => [{ type: 'text', text: result.content }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const result = await invoke('knowledge.bases.list', {}, exec.signal)
      if (!Array.isArray(result)) throw new Error('Invalid knowledge destination response')
      const entries = result.flatMap((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null || !('canManage' in entry) || entry.canManage !== true) return []
        const row = entry as Record<string, unknown>
        if (typeof row.id !== 'string' || typeof row.name !== 'string'
          || !['PERSONAL', 'DEPARTMENT', 'COMPANY'].includes(String(row.scope))
          || (row.ownerName !== undefined && typeof row.ownerName !== 'string')) {
          throw new Error('Invalid writable knowledge destination')
        }
        return [{ id: row.id, name: row.name, scope: row.scope,
          ...row.ownerName !== undefined ? { ownerName: row.ownerName } : {} }]
      })
      return { content: JSON.stringify({ entries: entries.slice(0, 128), truncated: entries.length > 128 }) }
    },
  })), 'product-knowledge-library.destinations')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_save',
    description: 'Save content as a new Markdown document only when the user explicitly asks to save a task result. Choose an exact writable ID from knowledge_destinations. Save to a department or company base only when the user explicitly chooses that destination. Do not save automatically, change ownership, or change task selection. Indexing continues after saving.',
    parameters: {
      knowledgeBaseId: { type: 'string', required: true, description: 'Writable knowledge base ID chosen by the user.' },
      title: { type: 'string', required: true, description: 'Document title.' },
      content: { type: 'string', required: true, description: 'Complete Markdown content to save.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args, result) => [{ type: 'text', text: result.content }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('Knowledge saving requires a Session')
      const operationId = createHash('sha256').update(`${exec.agent.session.id}:${exec.callId}`).digest('hex')
      const result = await invoke('knowledge.documents.save', { ...args, operationId }, exec.signal)
      return { content: JSON.stringify({ document: result, message: 'Document saved; use its processing state to determine when retrieval is ready.' }) }
    },
  })), 'product-knowledge-library.save')
}
