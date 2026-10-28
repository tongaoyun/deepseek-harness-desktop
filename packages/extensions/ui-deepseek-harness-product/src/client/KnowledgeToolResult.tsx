/** Durable knowledge sources rendered through the official toolview slot. */
import { useCallback, useState, type ReactNode } from 'react'
import { DisclosureRow, IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { KnowledgeDocumentReader } from './KnowledgeDocumentReader.tsx'
import { productErrorMessage } from './product-errors.ts'

type KnowledgeToolProps = Pick<ToolCallViewProps, 'toolName' | 'phase' | 'block' | 'useDisclosure'>
  & PropsLocale<typeof NS> & PropsRenderFactories
interface KnowledgeSource {
  readonly sourceId: string
  readonly knowledgeBaseId: string
  readonly knowledgeBaseName: string
  readonly documentId: string
  readonly filename: string
  readonly locator: string
}

function sources(meta: unknown): readonly KnowledgeSource[] | undefined {
  if (typeof meta !== 'object' || meta === null || !('kind' in meta) || meta.kind !== 'product-knowledge-sources-v1'
    || !('sources' in meta) || !Array.isArray(meta.sources) || meta.sources.length > 12) return undefined
  const result: KnowledgeSource[] = []
  for (const entry of meta.sources) {
    const row: unknown = entry
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
    const fields = row as Record<string, unknown>
    const { sourceId, knowledgeBaseId, knowledgeBaseName, documentId, filename, locator } = fields
    if (typeof sourceId !== 'string' || sourceId === '' || typeof knowledgeBaseId !== 'string' || knowledgeBaseId === ''
      || typeof knowledgeBaseName !== 'string' || typeof documentId !== 'string' || documentId === ''
      || typeof filename !== 'string' || filename === '' || typeof locator !== 'string') return undefined
    result.push({ sourceId, knowledgeBaseId, knowledgeBaseName, documentId, filename, locator })
  }
  return result
}

/** Render recorded sources and close live content when access is denied.
 * @param props Official tool call slice, disclosure hook, and product locale.
 * @returns A source disclosure and an authorized original-file reader.
 */
export function KnowledgeToolResult({ toolName, phase, block, useDisclosure, renderFactorySlot, t }: KnowledgeToolProps): ReactNode {
  const { expanded, toggle } = useDisclosure()
  const [selected, setSelected] = useState<KnowledgeSource>()
  const [readError, setReadError] = useState('')
  const accessDenied = useCallback((failure: unknown) => {
    setSelected(undefined)
    setReadError(productErrorMessage(failure, t, 'knowledgeReadFailed'))
  }, [t])
  const settled = phase === 'result' && 'kind' in block
  const failed = settled && block.isError
  const stopped = settled && block.error?.code === 'interrupted'
  const entries = settled && !failed ? sources(block.meta) : undefined
  const output = settled ? block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
    || (block.error === undefined ? '' : `${block.error.name}: ${block.error.code}`) : ''
  const title = t(toolName === 'knowledge_read' ? 'knowledgeToolRead' : 'knowledgeToolSearch')
  const state = !settled ? 'running' : stopped ? 'stopped' : failed ? 'error' : 'ok'
  const summary = !settled ? t('loading') : stopped ? t('knowledgeToolStopped') : failed
    ? t(toolName === 'knowledge_read' ? 'knowledgeReadFailed' : 'searchFailed')
    : entries === undefined ? '' : entries.length === 0 ? t('noSearchResults')
      : t('knowledgeToolSourcesCount').replace('{count}', String(entries.length))
  const expandable = settled && (output !== '' || entries !== undefined && entries.length > 0)
  return <div data-tool={toolName} data-state={state} className={css.knowledgeTool}>
    <DisclosureRow title={title} icon={<IconDatabaseOutlineRegular size={14} />} running={!settled}
      open={expanded && expandable} expandable={expandable} onToggle={toggle} expandOnRowClick
      collapsedContent={<span className={css.knowledgeToolSummary}>{summary}</span>}>
      {entries === undefined ? <pre className={css.knowledgeToolOutput}>{output}</pre>
        : entries.length === 0 ? <p className={css.catalogStatus}>{t('noSearchResults')}</p>
          : <ul className={css.knowledgeToolSources} aria-label={t('knowledgeToolSources')}>
            {entries.map(source => <li key={source.sourceId}>
              <button type="button" className={css.knowledgeSourceLink} onClick={() => { setReadError(''); setSelected(source) }}>{source.filename}</button>
              <span>{source.knowledgeBaseName}</span>{source.locator && <span>{source.locator}</span>}
            </li>)}
          </ul>}
    </DisclosureRow>
    {readError && <p className={css.catalogError} role="alert">{readError}</p>}
    {selected && <KnowledgeDocumentReader key={selected.sourceId} knowledgeBaseId={selected.knowledgeBaseId}
      sourceId={selected.sourceId} expectedDocumentId={selected.documentId} title={selected.filename} renderFactorySlot={renderFactorySlot}
      onAccessDenied={accessDenied} onClose={() => { setSelected(undefined) }} t={t} />}
  </div>
}

/** Register knowledge rows without replacing official transcript or file viewers.
 * @param ctx Client context whose product dictionary is already registered.
 */
export function registerKnowledgeToolResults(ctx: Context): void {
  for (const key of ['knowledge_search', 'knowledge_read']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, KnowledgeToolResult))
  }
}
