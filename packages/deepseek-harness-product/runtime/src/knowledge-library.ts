/** Explicit task-result saving through the product server and official tool approval. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { scopedProductInvoker } from './data.ts'

export const name = 'product-knowledge-library'
export const inject = ['tools']
/** Main-owned transport; employee credentials remain outside the Host. */
export interface Config { readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'> }

/** Register metadata discovery and an approved Markdown save operation.
 * @param ctx Product runtime context.
 * @param config Main-process transport.
 */
export function apply(ctx: Context, config: Config): void {
  const requests = scopedProductInvoker(config.product, 'Knowledge library unloaded')
  ctx.effect(() => requests.dispose, 'product-knowledge-library.requests')
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'knowledge_save'
    ? { kind: 'ask', reason: 'Save this task result as a searchable knowledge document.',
      displayReason: { en: 'Save this content to the knowledge base?', 'zh-CN': '将这份内容保存到知识库吗？' } }
    : next())
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_destinations',
    description: 'Find writable knowledge bases for explicitly saving a task result. Search by query or request successive pages while hasMore is true. Does not read documents or change task retrieval selection.',
    parameters: {
      query: { type: 'string', description: 'Search names, IDs or ownership. Maximum 200 characters.' },
      page: { type: 'integer', description: 'Page number starting at 1. Defaults to 1.' },
      size: { type: 'integer', description: 'Results per page, from 1 to 100. Defaults to 20.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args, result) => [{ type: 'text', text: result.content }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const page = args.page ?? 1
      const size = args.size ?? 20
      const query = args.query ?? ''
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000
        || !Number.isSafeInteger(size) || size < 1 || size > 100 || query.length > 200) {
        throw new Error('Invalid knowledge destination query')
      }
      const result = await requests.invoke('knowledge.bases.list', {}, exec.signal)
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
      const needle = query.trim().toLowerCase()
      const matches = entries.filter(entry => [entry.id, entry.name, entry.scope, entry.ownerName ?? '']
        .some(value => String(value).toLowerCase().includes(needle)))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const start = (page - 1) * size
      return { content: JSON.stringify({ entries: matches.slice(start, start + size), page, size,
        total: matches.length, hasMore: start + size < matches.length }) }
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
      const result = await requests.invoke('knowledge.documents.save', { ...args, operationId }, exec.signal)
      return { content: JSON.stringify({ document: result, message: 'Document saved; use its processing state to determine when retrieval is ready.' }) }
    },
  })), 'product-knowledge-library.save')
}
