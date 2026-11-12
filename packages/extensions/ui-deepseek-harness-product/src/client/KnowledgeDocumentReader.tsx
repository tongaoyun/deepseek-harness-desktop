import { ProductLoading } from './ProductLoading.tsx'
/** Original-file preview and retrieval passages use separate authorized reads. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconDownloadOutlineRegular, IconLinkOutlineRegular, MarkdownText, Modal, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewFile } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { markdownLabels } from './catalog-shared.tsx'
import {
  isKnowledgeAccessDenied, knowledgeDocument, knowledgePassage, readKnowledgeFile, useKnowledgeRequests,
  type KnowledgeDocument, type KnowledgePassage,
} from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'

/** Preview an original file or read the selected retrieval passage.
 * Removed read controls hand their owned focus to the reader without scrolling; focus elsewhere is retained.
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
  const selection = JSON.stringify([knowledgeBaseId, documentId, sourceId, expectedDocumentId])
  const [sourceSnapshot, setSourceSnapshot] = useState<{ readonly selection: string; readonly value: KnowledgePassage }>()
  const source = sourceSnapshot?.selection === selection ? sourceSnapshot.value : undefined
  const [fullDocument, setFullDocument] = useState<{ readonly selection: string; readonly id: string }>()
  const fullDocumentId = fullDocument?.selection === selection ? fullDocument.id : undefined
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(sourceId !== undefined)
  const [revision, setRevision] = useState(0)
  const originalDocumentId = fullDocumentId ?? documentId
  const reader = useRef<HTMLElement>(null)
  const preserveReadFocus = useResultFocus(reader, reader)
  const openOriginal = useRef<HTMLButtonElement>(null)
  const restoreReadFocus = useCallback((origin: HTMLElement | null): void => {
    const target = reader.current
    if (target && origin?.contains(target.ownerDocument.activeElement)) focusWithoutRing(target, { preventScroll: true })
  }, [])
  useEffect(() => { setSourceSnapshot(undefined); setFullDocument(undefined); setError(undefined) }, [selection])
  useEffect(() => {
    if (sourceId === undefined || fullDocumentId !== undefined) return
    const controller = new AbortController()
    setLoading(true)
    void request('knowledge.sources.read', { sourceId }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      const source = knowledgePassage(value, { knowledgeBaseId, sourceId,
        ...expectedDocumentId === undefined ? {} : { documentId: expectedDocumentId } })
      preserveReadFocus()
      setSourceSnapshot({ selection, value: source })
      setError(undefined)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      preserveReadFocus()
      restoreReadFocus(openOriginal.current)
      setSourceSnapshot(undefined); setError(failure)
      if (isKnowledgeAccessDenied(failure)) onAccessDenied?.(failure)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, sourceId, expectedDocumentId, fullDocumentId, revision,
    refreshRevision, onAccessDenied, selection, restoreReadFocus, preserveReadFocus])
  const controls = <>
    {source?.documentId && originalDocumentId === undefined && <Button ref={openOriginal} variant="outline" size="sm"
      className={loading ? 'product-control-pending' : undefined} aria-disabled={loading}
      onClick={(event) => {
        if (loading) return
        restoreReadFocus(event.currentTarget)
        setFullDocument({ selection, id: source.documentId })
      }}>{t('knowledgeReadFullDocument')}</Button>}
    {!inline && originalDocumentId && <KnowledgeFileControls key={JSON.stringify([knowledgeBaseId, originalDocumentId])}
      knowledgeBaseId={knowledgeBaseId} documentId={originalDocumentId}
      {...onAccessDenied === undefined ? {} : { onAccessDenied }} t={t} />}
    {!inline && <Button variant="ghost" size="sm" onClick={onClose}>{t('close')}</Button>}
  </>
  const body = originalDocumentId !== undefined ? <>
    {source?.locator && <p className={css.knowledgeLocator}>{source.locator}</p>}
    <div className={css.knowledgeOriginalViewport} data-knowledge-original-viewport>
      <KnowledgeOriginalDocument key={JSON.stringify([knowledgeBaseId, originalDocumentId])}
        knowledgeBaseId={knowledgeBaseId} documentId={originalDocumentId}
        refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot} onReady={restoreReadFocus} t={t}
        {...onAccessDenied === undefined ? {} : { onAccessDenied }} />
    </div></> : <>
    <p className={css.knowledgeLocator}>{t('knowledgeExtractedContent')}</p>
    {loading && source === undefined && error === undefined && <ProductLoading label={t('loading')} />}
    {error !== undefined && <div><p className={css.catalogError} role="alert">{productErrorMessage(error, t, 'knowledgeReadFailed')}</p><Button variant="outline" size="sm"
      aria-disabled={loading} aria-busy={loading} className={loading ? 'product-control-pending' : undefined}
      onClick={() => {
        if (loading) return
        setLoading(true); setRevision(value => value === revision ? revision + 1 : value)
      }}>{t('retry')}</Button></div>}
    {source && <section className={css.knowledgePassage} aria-busy={loading}>
      {source.locator && <p className={css.knowledgeLocator}>{source.locator}</p>}
      {source.content.trim() ? <div className={css.markdown}><MarkdownText text={source.content} labels={markdownLabels(t)} /></div>
        : <p className={css.catalogStatus} role="status">{t('knowledgeNoContent')}</p>}
    </section>}
  </>
  if (inline) return <section ref={reader} tabIndex={-1} className={`${css.knowledgeWorkspaceReader} ${originalDocumentId !== undefined ? css.knowledgeOriginalReader : ''}`}
    aria-label={t('knowledgeReadDocument')} data-knowledge-inline-reader>
    {body}{source?.documentId && originalDocumentId === undefined && <footer>{controls}</footer>}
  </section>
  return <Modal open headless title={title} onClose={onClose}
    className={`${css.knowledgeReaderModal} ${originalDocumentId !== undefined ? css.knowledgeOriginalModal : ''}`}>
    <header className={css.knowledgeReaderHeader}>
      <h2>{title}</h2><Button variant="ghost" size="sm" className={css.knowledgeReaderClose}
        aria-label={t('close')} onClick={onClose}><IconCloseOutlineRegular size={14} /></Button>
    </header>
    <section ref={reader} tabIndex={-1} aria-label={t('knowledgeReadDocument')}
      className={`${css.knowledgeReaderContent} ${originalDocumentId !== undefined ? css.knowledgeOriginalReader : ''}`}>
      {body}
    </section>
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
  const [pending, setPending] = useState<'download' | 'openExternal'>()
  const writing = useRef(false)
  const [error, setError] = useState<{ readonly failure: unknown; readonly action: 'download' | 'openExternal' }>()
  const operation = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    return () => { controller.abort() }
  }, [])
  const open = async (action: 'download' | 'openExternal'): Promise<void> => {
    if (writing.current) return
    const controller = operation.current
    writing.current = true
    setPending(action)
    try {
      await request(`knowledge.documents.${action}`, { knowledgeBaseId, documentId }, controller.signal)
      if (!controller.signal.aborted) setError(undefined)
    }
    catch (failure) {
      if (controller.signal.aborted) return
      setError({ failure, action })
      if (isKnowledgeAccessDenied(failure)) onAccessDenied?.(failure)
    } finally { writing.current = false; if (!controller.signal.aborted) setPending(undefined) }
  }
  return <>
    {error !== undefined && <p className={css.catalogError} role="alert">{productErrorMessage(error.failure, t,
      error.action === 'download' ? 'knowledgeDownloadFailed' : 'knowledgeOpenExternalFailed')}</p>}
    <Button variant="outline" size="sm" className={pending ? 'product-control-pending' : undefined} aria-disabled={pending !== undefined}
      aria-busy={pending === 'download'} onClick={() => { void open('download') }}>
      <IconDownloadOutlineRegular size={16} />{t('knowledgeDownloadOriginal')}</Button>
    {globalThis.location.protocol === 'dsh-app:' && globalThis.location.hostname === 'app' && <Button variant="outline" size="sm"
      className={pending ? 'product-control-pending' : undefined} aria-disabled={pending !== undefined} aria-busy={pending === 'openExternal'}
      onClick={() => { void open('openExternal') }}><IconLinkOutlineRegular size={16} />{t('knowledgeOpenExternal')}</Button>}
  </>
}

function KnowledgeOriginalDocument({
  knowledgeBaseId, documentId, refreshRevision, renderFactorySlot, onAccessDenied, onReady, t,
}: PropsRenderFactories & {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly refreshRevision: number
  readonly onReady: (retry: HTMLButtonElement | null) => void
  readonly onAccessDenied?: (failure: unknown) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [metadata, setMetadata] = useState<{ readonly revision: number; readonly value: KnowledgeDocument }>()
  const [metadataError, setMetadataError] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [metadataRevision, setMetadataRevision] = useState(0)
  const retry = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    setMetadata(undefined); setLoading(true)
    void request('knowledge.documents.previewMetadata', { knowledgeBaseId, documentId }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      const document = knowledgeDocument(value)
      if (document.id !== documentId || document.knowledgeBaseId !== knowledgeBaseId) throw new Error('Knowledge document identity changed')
      onReady(retry.current)
      setMetadata({ revision: refreshRevision, value: document })
      setMetadataError(undefined)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      setMetadataError(failure)
      if (isKnowledgeAccessDenied(failure)) onAccessDenied?.(failure)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, documentId, refreshRevision, metadataRevision, onAccessDenied, onReady])
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
  if (metadataError !== undefined) return <div><p role="alert" className={css.catalogError}>{productErrorMessage(metadataError, t, 'knowledgePreviewFailed')}</p><Button ref={retry} variant="outline" size="sm"
    aria-disabled={loading} aria-busy={loading} className={loading ? 'product-control-pending' : undefined}
    onClick={() => {
      if (loading) return
      setLoading(true); setMetadataRevision(value => value === metadataRevision ? metadataRevision + 1 : value)
    }}>{t('retry')}</Button></div>
  if (metadata === undefined || metadata.revision !== refreshRevision) return <ProductLoading label={t('loading')} />
  const filename = metadata.value.sourceType === 'manual' && !/\.md$/iu.test(metadata.value.filename)
    ? `${metadata.value.filename}.md` : metadata.value.filename
  return renderFactorySlot('document.preview', { fileName: filename, read: readFile, renderOffice, revision: refreshRevision, failureText },
    { fallback: <p className={css.catalogError} role="alert">{t('knowledgePreviewUnavailable')}</p> })
}
