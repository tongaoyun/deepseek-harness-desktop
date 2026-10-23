import { ProductLoading } from './ProductLoading.tsx'
/** Original-file preview and retrieval passages use separate authorized reads. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconDownloadOutlineRegular, IconLinkOutlineRegular, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewFile } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { markdownLabels } from './catalog-shared.tsx'
import {
  isKnowledgeAccessDenied, knowledgeDocument, readKnowledgeFile, knowledgeSearchResults, useKnowledgeRequests,
  type KnowledgeDocument, type KnowledgeSearchResult,
} from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'

/** Preview an original file or read the selected retrieval passage.
 * @param props Stable library and document or source identity, and the official preview factory.
 * @returns An inline preview or a dismissible reader with authorized source navigation.
 */
export function KnowledgeDocumentReader({ knowledgeBaseId, documentId, sourceId, title, inline, refreshRevision = 0,
  expectedDocumentId, renderFactorySlot, onAccessDenied, onClose, t }: PropsRenderFactories & {
    readonly knowledgeBaseId: string
    readonly documentId?: string
    readonly sourceId?: string
    readonly expectedDocumentId?: string
    readonly title: string
    readonly inline?: boolean
    readonly refreshRevision?: number
    readonly onAccessDenied?: (failure: unknown) => void
    readonly onClose: () => void
    readonly t: (key: DeepSeekHarnessProductKey) => string
  }): ReactNode {
  const request = useKnowledgeRequests()
  const [source, setSource] = useState<KnowledgeSearchResult>()
  const [fullDocumentId, setFullDocumentId] = useState<string>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(sourceId !== undefined)
  const [revision, setRevision] = useState(0)
  const originalDocumentId = fullDocumentId ?? documentId
  useEffect(() => { setSource(undefined); setFullDocumentId(undefined) }, [knowledgeBaseId, documentId, sourceId])
  useEffect(() => {
    if (sourceId === undefined || fullDocumentId !== undefined) return
    const controller = new AbortController()
    setLoading(true); setError(''); setSource(undefined)
    void request('knowledge.sources.read', { sourceId }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      const result = knowledgeSearchResults([value])[0]
      if (result === undefined) throw new Error('Invalid knowledge source')
      if (result.knowledgeBaseId !== undefined && result.knowledgeBaseId !== knowledgeBaseId
        || result.sourceId !== undefined && result.sourceId !== sourceId
        || expectedDocumentId !== undefined && (result.documentId !== expectedDocumentId
          || result.knowledgeBaseId !== knowledgeBaseId || result.sourceId !== sourceId)) throw new Error('Knowledge source identity changed')
      setSource(result)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      setError(productErrorMessage(failure, t, 'knowledgeReadFailed'))
      if (isKnowledgeAccessDenied(failure)) { setSource(undefined); onAccessDenied?.(failure) }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, sourceId, expectedDocumentId, fullDocumentId, revision, refreshRevision, onAccessDenied, t])
  const controls = <>
    {source?.documentId && originalDocumentId === undefined && <Button variant="outline" size="sm" disabled={loading}
      onClick={() => { setFullDocumentId(source.documentId) }}>{t('knowledgeReadFullDocument')}</Button>}
    {!inline && originalDocumentId && <KnowledgeFileControls knowledgeBaseId={knowledgeBaseId} documentId={originalDocumentId}
      {...onAccessDenied === undefined ? {} : { onAccessDenied }} t={t} />}
    {!inline && <Button variant="ghost" size="sm" onClick={onClose}>{t('close')}</Button>}
  </>
  const body = originalDocumentId !== undefined ? <>
    {source?.locator && <p className={css.knowledgeLocator}>{source.locator}</p>}
    <div className={css.knowledgeOriginalViewport} data-knowledge-original-viewport>
      <KnowledgeOriginalDocument key={originalDocumentId}
        knowledgeBaseId={knowledgeBaseId} documentId={originalDocumentId}
        refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot} t={t}
        {...onAccessDenied === undefined ? {} : { onAccessDenied }} />
    </div></> : <>
    <p className={css.knowledgeLocator}>{t('knowledgeExtractedContent')}</p>
    {loading && <ProductLoading label={t('loading')} />}
    {error && <div><p className={css.catalogError} role="alert">{error}</p><Button variant="outline" size="sm"
      onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</Button></div>}
    {source && <section className={css.knowledgePassage}>
      {source.locator && <p className={css.knowledgeLocator}>{source.locator}</p>}
      {source.content.trim() ? <div className={css.markdown}><MarkdownText text={source.content} labels={markdownLabels(t)} /></div>
        : <p className={css.catalogStatus} role="status">{t('knowledgeNoContent')}</p>}
    </section>}
  </>
  if (inline) return <section className={`${css.knowledgeWorkspaceReader} ${originalDocumentId !== undefined ? css.knowledgeOriginalReader : ''}`}
    aria-label={t('knowledgeReadDocument')} data-knowledge-inline-reader>
    {body}{source?.documentId && originalDocumentId === undefined && <footer>{controls}</footer>}
  </section>
  return <Modal open headless title={title} onClose={onClose}
    className={`${css.knowledgeReaderModal} ${originalDocumentId !== undefined ? css.knowledgeOriginalModal : ''}`}>
    <header className={css.knowledgeReaderHeader}>
      <h2>{title}</h2><Button variant="ghost" size="sm" className={css.knowledgeReaderClose}
        aria-label={t('close')} onClick={onClose}><IconCloseOutlineRegular size={14} /></Button>
    </header>
    <div className={`${css.knowledgeReaderContent} ${originalDocumentId !== undefined ? css.knowledgeOriginalReader : ''}`}>
      {body}
    </div>
    <footer className={css.knowledgeReaderFooter}>{controls}</footer>
  </Modal>
}

function KnowledgeFileControls({ knowledgeBaseId, documentId, onAccessDenied, t }: {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly onAccessDenied?: (failure: unknown) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    return () => { controller.abort() }
  }, [])
  const open = async (action: 'download' | 'openExternal'): Promise<void> => {
    if (pending) return
    const controller = operation.current
    setPending(true); setError('')
    try { await request(`knowledge.documents.${action}`, { knowledgeBaseId, documentId }, controller.signal) }
    catch (failure) {
      if (controller.signal.aborted) return
      setError(productErrorMessage(failure, t, action === 'download' ? 'knowledgeDownloadFailed' : 'knowledgeOpenExternalFailed'))
      if (isKnowledgeAccessDenied(failure)) onAccessDenied?.(failure)
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  return <>
    {error && <p className={css.catalogError} role="alert">{error}</p>}
    <Button variant="outline" size="sm" disabled={pending} onClick={() => { void open('download') }}>
      <IconDownloadOutlineRegular size={16} />{t('knowledgeDownloadOriginal')}</Button>
    {globalThis.location.protocol === 'dsh-app:' && globalThis.location.hostname === 'app' && <Button variant="outline" size="sm" disabled={pending}
      onClick={() => { void open('openExternal') }}><IconLinkOutlineRegular size={16} />{t('knowledgeOpenExternal')}</Button>}
  </>
}

function KnowledgeOriginalDocument({
  knowledgeBaseId, documentId, refreshRevision, renderFactorySlot, onAccessDenied, t,
}: PropsRenderFactories & {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly refreshRevision: number
  readonly onAccessDenied?: (failure: unknown) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [metadata, setMetadata] = useState<{ readonly revision: number; readonly value: KnowledgeDocument }>()
  const [metadataError, setMetadataError] = useState('')
  const [metadataRevision, setMetadataRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setMetadata(undefined); setMetadataError('')
    void request('knowledge.documents.previewMetadata', { knowledgeBaseId, documentId }, controller.signal).then((value) => {
      if (!controller.signal.aborted) setMetadata({ revision: refreshRevision, value: knowledgeDocument(value) })
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      setMetadataError(productErrorMessage(failure, t, 'knowledgePreviewFailed'))
      if (isKnowledgeAccessDenied(failure)) onAccessDenied?.(failure)
    })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, documentId, refreshRevision, metadataRevision, onAccessDenied, t])
  const read = useCallback(async (
    rendered: boolean, signal: AbortSignal,
  ): Promise<DocumentPreviewFile> => {
    try {
      return await readKnowledgeFile(request, { knowledgeBaseId, documentId, ...(rendered ? { rendered: true } : {}) },
        signal)
    }
    catch (failure) {
      if (!signal.aborted && isKnowledgeAccessDenied(failure)) onAccessDenied?.(failure)
      throw failure
    }
  }, [request, knowledgeBaseId, documentId, metadata, onAccessDenied])
  const readFile = useCallback((signal: AbortSignal) => read(false, signal), [read])
  const renderOffice = useCallback((signal: AbortSignal) => read(true, signal), [read])
  const failureText = useCallback((failure: unknown) => productErrorMessage(failure, t, 'knowledgePreviewFailed'), [t])
  if (metadataError) return <div><p role="alert" className={css.catalogError}>{metadataError}</p><Button variant="outline" size="sm"
    onClick={() => { setMetadataRevision(value => value + 1) }}>{t('retry')}</Button></div>
  if (metadata === undefined || metadata.revision !== refreshRevision) return <ProductLoading label={t('loading')} />
  const filename = metadata.value.sourceType === 'manual' && !/\.md$/iu.test(metadata.value.filename)
    ? `${metadata.value.filename}.md` : metadata.value.filename
  return renderFactorySlot('document.preview', { fileName: filename, read: readFile, renderOffice, revision: refreshRevision, failureText },
    { fallback: <p className={css.catalogError} role="alert">{t('knowledgePreviewUnavailable')}</p> })
}
