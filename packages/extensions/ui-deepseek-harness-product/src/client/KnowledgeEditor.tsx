/** Manual documents, website imports, and folders use explicit idempotent save operations. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { knowledgeDocument, knowledgeFolder, useKnowledgeRequests, type KnowledgeDocument, type KnowledgeFolder } from './knowledge-data.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { productErrorMessage } from './product-errors.ts'

/** A manager's create or edit action captured before opening the form. */
export type KnowledgeEditorTarget = { readonly kind: 'markdown'; readonly document?: KnowledgeDocument; readonly folderId?: string | null }
  | { readonly kind: 'url'; readonly folderId?: string | null } | { readonly kind: 'folder'; readonly folder?: KnowledgeFolder; readonly parentId?: string | null }

/** Preserve content and retry identity on failed saves; closing cancels in-flight work.
 * @param props Current library, editor action, and commit callback.
 * @returns Text or URL editor with guarded manual-document modification.
 */
export function KnowledgeEditor({ knowledgeBaseId, target, onClose, onSaved, t }: {
  readonly knowledgeBaseId: string
  readonly target: KnowledgeEditorTarget
  readonly onClose: () => void
  readonly onSaved: (folder?: KnowledgeFolder) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [title, setTitle] = useState(target.kind === 'folder' ? target.folder?.name ?? '' : target.kind === 'markdown' ? target.document?.filename.replace(/\.md$/iu, '') ?? '' : '')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [parentId, setParentId] = useState(target.kind === 'folder' ? target.folder?.parentId ?? target.parentId ?? null : null)
  const [parentReady, setParentReady] = useState(false)
  const [metadata, setMetadata] = useState<KnowledgeDocument>()
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<KnowledgeDocument>()
  const [loading, setLoading] = useState(target.kind === 'markdown' && target.document !== undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const operation = useRef<{ controller: AbortController; id?: string }>({ controller: new AbortController() })
  useEffect(() => {
    const controller = new AbortController()
    operation.current.controller = controller
    return () => { controller.abort() }
  }, [])
  useEffect(() => {
    if (target.kind !== 'markdown' || !target.document) return
    const controller = new AbortController()
    setLoading(true); setError('')
    void request('knowledge.documents.get', { knowledgeBaseId, documentId: target.document.id }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        const document = knowledgeDocument(value)
        if (document.sourceType !== 'manual' || document.canManage !== true || document.manualContent === undefined) throw new Error('Document is not editable')
        setMetadata(document); setTitle(document.filename.replace(/\.md$/iu, '')); setContent(document.manualContent)
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(productErrorMessage(failure, t, 'knowledgeReadFailed')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, target, revision, t])
  const change = (set: (value: string) => void, value: string) => {
    set(value); setError(''); delete operation.current.id
  }
  const save = async (): Promise<void> => {
    if (pending || loading || conflict || target.kind === 'folder' && !target.folder && !parentReady) return
    setPending(true); setError('')
    operation.current.id ??= globalThis.crypto.randomUUID()
    const operationId = operation.current.id
    const controller = operation.current.controller
    try {
      if (target.kind === 'folder') {
        const saved = await request(target.folder ? 'knowledge.folders.rename' : 'knowledge.folders.create', {
          knowledgeBaseId, name: title.trim(), operationId,
          ...(target.folder ? { folderId: target.folder.id } : { parentId }),
        }, controller.signal)
        if (!controller.signal.aborted) onSaved(knowledgeFolder(saved))
      } else if (target.kind === 'url') {
        await request('knowledge.documents.importUrl', { knowledgeBaseId, url: url.trim(), operationId,
          folderId: target.folderId ?? null,
          ...(title.trim() ? { title: title.trim() } : {}) }, controller.signal)
      } else {
        await request('knowledge.documents.save', { knowledgeBaseId, title: title.trim(), content, operationId,
          ...(metadata ? { documentId: metadata.id, expectedUpdatedAt: metadata.updatedAt } : { folderId: target.folderId ?? null }),
        }, controller.signal)
      }
      if (!controller.signal.aborted && target.kind !== 'folder') onSaved()
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (productFailure(failure).code === 'KNOWLEDGE_DOCUMENT_CONFLICT') { setConflict(true); setLatest(undefined) }
        setError(productErrorMessage(failure, t, 'knowledgeSaveFailed'))
      }
    }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  const readLatest = async (): Promise<void> => {
    if (!metadata || loading || pending) return
    const controller = operation.current.controller
    setLoading(true); setError('')
    try {
      const document = knowledgeDocument(await request('knowledge.documents.get', {
        knowledgeBaseId, documentId: metadata.id,
      }, controller.signal))
      controller.signal.throwIfAborted()
      if (document.sourceType !== 'manual' || document.canManage !== true || document.manualContent === undefined) {
        throw new ProductError('KNOWLEDGE_MANAGEMENT_FORBIDDEN', 'Document is not editable')
      }
      setLatest(document)
    } catch (failure) { if (!controller.signal.aborted) setError(productErrorMessage(failure, t, 'knowledgeReadFailed')) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const titleKey = target.kind === 'folder' ? target.folder ? 'knowledgeRenameFolder' : 'knowledgeCreateFolder'
    : target.kind === 'url' ? 'knowledgeImportUrl' : target.document ? 'knowledgeEditDocument' : 'knowledgeNewDocument'
  const validUrl = (() => {
    try {
      const parsed = new URL(url)
      return ['https:', 'http:'].includes(parsed.protocol) && parsed.username === '' && parsed.password === ''
    } catch { return false }
  })()
  const valid = (target.kind !== 'folder' || target.folder !== undefined || parentReady)
    && (target.kind === 'url' ? validUrl : title.trim() !== '' && (target.kind === 'folder' || content.trim() !== ''))
  const editable = target.kind !== 'markdown' || target.document === undefined || metadata !== undefined
  return <Modal open title={t(titleKey)} closeLabel={t('close')} onClose={onClose}
    className={(target.kind === 'folder' ? css.knowledgeBaseEditorModal : css.knowledgeEditorModal) as string}
    contentClassName={css.knowledgeEditorContent as string} footer={<>
      <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" size="sm" disabled={pending || loading || conflict || !valid || !editable} onClick={() => { void save() }}>{t(pending ? 'saving' : 'knowledgeSave')}</Button>
    </>}>
    <form className={css.knowledgeEditorForm} onSubmit={(event) => { event.preventDefault(); if (valid && editable) void save() }}>
      <label>{t(target.kind === 'folder' ? 'knowledgeFolderName' : 'knowledgeDocumentTitle')}
        <input data-modal-autofocus value={title} maxLength={target.kind === 'folder' ? 80 : 120} disabled={pending || loading}
          onChange={(event) => { change(setTitle, event.currentTarget.value) }} /></label>
      {target.kind === 'folder' && !target.folder && <KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId}
        label={t('knowledgeParentFolder')} value={parentId} disabled={pending} onReady={setParentReady}
        onChange={(id) => { setParentId(id); setParentReady(false); setError(''); delete operation.current.id }} t={t} />}
      {target.kind === 'url' && <label>{t('knowledgeWebsiteUrl')}<input value={url} type="url" maxLength={2_000} disabled={pending}
        onChange={(event) => { change(setUrl, event.currentTarget.value) }} /></label>}
      {target.kind === 'markdown' && <label>{t('knowledgeMarkdownContent')}<textarea value={content} disabled={pending || loading || !editable}
        onChange={(event) => { change(setContent, event.currentTarget.value) }} /></label>}
      {loading && <p role="status" className={css.catalogStatus}>{t('loading')}</p>}
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {conflict && <>
        <p>{t('knowledgeConflictDraftRetained')}</p>
        <Button variant="outline" size="sm" disabled={loading || pending} onClick={() => { void readLatest() }}>{t('knowledgeReadLatest')}</Button>
        {latest && <>
          <details><summary>{t('knowledgeLatestVersion')}</summary><p>{latest.filename}</p>
            <textarea readOnly aria-label={t('knowledgeLatestVersion')} value={latest.manualContent ?? ''} /></details>
          <Button variant="outline" size="sm" disabled={loading || pending} onClick={() => {
            setMetadata(latest); setConflict(false); setLatest(undefined); setError(''); delete operation.current.id
          }}>{t('knowledgeContinueDraft')}</Button>
        </>}
      </>}
      {!loading && !editable && <Button variant="outline" size="sm" onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</Button>}
    </form>
  </Modal>
}
