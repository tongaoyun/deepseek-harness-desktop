/** On-demand engine stages and summary management within the document reader. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { KnowledgeProcessingSchema, type KnowledgeProcessing } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { markdownLabels } from './catalog-shared.tsx'
import { isKnowledgeAccessDenied, useKnowledgeRequests } from './knowledge-data.ts'
import { confirmKnowledgeDocumentMutation } from './knowledge-mutation-receipts.ts'
import { ProductLoading } from './ProductLoading.tsx'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'

const stageLabels: Record<KnowledgeProcessing['stages'][number]['name'], DeepSeekHarnessProductKey> = {
  DOCUMENT: 'knowledgeStageDocument', CHUNKING: 'knowledgeStageChunking', EMBEDDING: 'knowledgeStageEmbedding',
  MULTIMODAL: 'knowledgeStageMultimodal', ENRICHMENT: 'knowledgeStageEnrichment',
}
const stageStates: Record<KnowledgeProcessing['stages'][number]['status'], DeepSeekHarnessProductKey> = {
  PENDING: 'knowledgeQueued', RUNNING: 'knowledgeProcessing', COMPLETED: 'knowledgeStageCompleted',
  FAILED: 'knowledgeIndexFailed', SKIPPED: 'knowledgeStageSkipped', CANCELLED: 'knowledgeCancelled',
}
const summaryStates: Record<KnowledgeProcessing['summaryStatus'], DeepSeekHarnessProductKey> = {
  NONE: 'knowledgeSummaryEmpty', PENDING: 'knowledgeQueued', PROCESSING: 'knowledgeProcessing',
  COMPLETED: 'knowledgeStageCompleted', FAILED: 'knowledgeIndexFailed',
}

/** Read only while mounted; active work refreshes until settled or a read fails.
 * Removed summary links and actions return their owned focus to the details region without scrolling.
 * @param props Document identity, management permission, refresh generation and localized labels.
 * @returns Sanitized stages, summary and an explicit idempotent summary refresh action.
 */
export function KnowledgeProcessingDetails({ knowledgeBaseId, documentId, canManage, refreshRevision, onAccessDenied, t }: {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly canManage: boolean
  readonly refreshRevision: number
  readonly onAccessDenied: (failure: unknown) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const content = useRef<HTMLElement>(null)
  const preserveReadFocus = useResultFocus(content, content)
  const [data, setData] = useState<KnowledgeProcessing>()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<unknown>()
  const [writeError, setWriteError] = useState<unknown>()
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const write = useRef<AbortController>()
  const operationId = useRef<string>()
  useEffect(() => () => { write.current?.abort() }, [request])
  useEffect(() => { setData(undefined); setReadError(undefined) }, [request, knowledgeBaseId, documentId])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void request('knowledge.documents.processing', { knowledgeBaseId, documentId }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      const result = KnowledgeProcessingSchema.parse(value)
      if (result.documentId !== documentId || result.knowledgeBaseId !== knowledgeBaseId) throw new Error('Knowledge document identity changed')
      preserveReadFocus()
      setData(result)
      setReadError(undefined)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      preserveReadFocus()
      setData(undefined); setReadError(failure)
      if (isKnowledgeAccessDenied(failure)) onAccessDenied(failure)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, documentId, refreshRevision, revision, onAccessDenied, preserveReadFocus])
  useEffect(() => {
    if (loading || pending || readError !== undefined || data === undefined
      || !['QUEUED', 'PROCESSING', 'FINALIZING'].includes(data.status) && !['PENDING', 'PROCESSING'].includes(data.summaryStatus)) return
    const timer = globalThis.setTimeout(() => { setRevision(value => value + 1) }, 3_000)
    return () => { globalThis.clearTimeout(timer) }
  }, [data, loading, pending, readError])
  const refreshSummary = async (): Promise<void> => {
    if (write.current !== undefined || loading || !canManage || data?.status !== 'READY' || !data.summaryEnabled
      || ['PENDING', 'PROCESSING'].includes(data.summaryStatus)) return
    const controller = new AbortController()
    write.current = controller
    operationId.current ??= globalThis.crypto.randomUUID()
    setPending(true); setAccepted(false)
    try {
      const target = { knowledgeBaseId, documentId, operationId: operationId.current }
      const receipt = await request('knowledge.documents.summary.refresh', target, controller.signal)
      controller.signal.throwIfAborted()
      confirmKnowledgeDocumentMutation('summary', receipt, target)
      operationId.current = undefined
      setWriteError(undefined)
      setAccepted(true); setRevision(value => value + 1)
    } catch (failure) {
      if (controller.signal.aborted) return
      setWriteError(failure)
      if (isKnowledgeAccessDenied(failure)) onAccessDenied(failure)
    } finally {
      if (!controller.signal.aborted) { write.current = undefined; setPending(false) }
    }
  }
  return <section ref={content} tabIndex={-1} className={css.knowledgeProcessingDetails}
    data-knowledge-inline-reader aria-label={t('knowledgeProcessingDetails')} aria-busy={loading}>
    <header><h2>{t('knowledgeProcessingDetails')}</h2>
      <Button variant="ghost" size="sm" className={loading || pending ? 'product-control-pending' : undefined}
        aria-disabled={loading || pending} aria-busy={loading} onClick={() => {
          if (loading || pending) return
          setLoading(true); setRevision(value => value === revision ? value + 1 : value)
        }}>
        <IconRefreshOutlineRegular size={14} />{t('refresh')}</Button></header>
    {readError !== undefined && <p role="alert" className={css.catalogError}>{productErrorMessage(readError, t, 'knowledgeProcessingReadFailed')}</p>}
    {loading && data === undefined && readError === undefined && <ProductLoading label={t('loading')} />}
    {data && <>
      {data.stalled && <p role="status" className={css.knowledgeBrowseHint}>{t('knowledgeProcessingStalled')}</p>}
      {data.stages.length === 0 ? <p className={css.knowledgeBrowseHint}>{t('knowledgeProcessingNoStages')}</p>
        : <table className={css.knowledgeStages}>
          <thead><tr><th scope="col">{t('knowledgeProcessingStage')}</th><th scope="col">{t('status')}</th><th scope="col">{t('knowledgeProcessingDuration')}</th></tr></thead>
          <tbody>{data.stages.map(stage => <tr key={stage.name} data-state={stage.status}>
            <th scope="row">{t(stageLabels[stage.name])}</th><td>{t(stageStates[stage.status])}</td>
            <td>{stage.durationMillis === null ? '—' : t('knowledgeProcessingSeconds').replace('{seconds}', String(Math.round(stage.durationMillis / 100) / 10))}</td>
          </tr>)}</tbody>
        </table>}
      {data.stages.some(stage => stage.status === 'FAILED') && <p className={css.knowledgeBrowseHint}>{t('knowledgeProcessingFailureHint')}</p>}
      <section className={css.knowledgeProcessingSummary} aria-label={t('knowledgeSummary')}>
        <header><div><h2>{t('knowledgeSummary')}</h2><span role="status">{t(summaryStates[data.summaryStatus])}</span></div>
          {canManage && data.summaryEnabled && <Button variant="outline" size="sm"
            className={(pending || loading) && data.status === 'READY' && !['PENDING', 'PROCESSING'].includes(data.summaryStatus) ? 'product-control-pending' : undefined}
            aria-disabled={pending || loading || data.status !== 'READY' || ['PENDING', 'PROCESSING'].includes(data.summaryStatus)} aria-busy={pending}
            onClick={() => { void refreshSummary() }}>{t(pending ? 'knowledgeSummarySubmitting' : 'knowledgeSummaryRegenerate')}</Button>}</header>
        {!data.summaryEnabled && <p className={css.knowledgeBrowseHint}>{t('knowledgeSummaryDisabled')}</p>}
        {accepted && <p role="status" className={css.knowledgeBrowseHint}>{t('knowledgeSummaryAccepted')}</p>}
        {writeError !== undefined && <p role="alert" className={css.catalogError}>{productErrorMessage(writeError, t, 'knowledgeChangeFailed')}</p>}
        {data.summary.trim() !== '' && <div className={css.markdown}><MarkdownText text={data.summary} labels={markdownLabels(t)} /></div>}
      </section>
    </>}
  </section>
}
