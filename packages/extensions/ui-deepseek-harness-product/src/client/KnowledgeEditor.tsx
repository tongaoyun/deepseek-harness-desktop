import { ProductLoading } from './ProductLoading.tsx'
/** Manual documents, website imports, and folders use explicit idempotent save operations. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { knowledgeDocument, knowledgeFolder, useKnowledgeRequests, type KnowledgeDocument, type KnowledgeFolder } from './knowledge-data.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useKnowledgeSaveRecovery, type KnowledgeSaveDraft } from './knowledge-save-recovery.ts'

/** A manager's create or edit action captured before opening the form. */
export type KnowledgeEditorTarget = { readonly kind: 'markdown'; readonly document?: KnowledgeDocument; readonly folderId?: string | null }
  | { readonly kind: 'url'; readonly folderId?: string | null } | { readonly kind: 'folder'; readonly folder?: KnowledgeFolder; readonly parentId?: string | null }

interface KnowledgeEditorProps {
  readonly knowledgeBaseId: string
  readonly target: KnowledgeEditorTarget
  readonly onClose: () => void
  readonly onSaved: (folder?: KnowledgeFolder) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}

function editorDocument(value: unknown, knowledgeBaseId: string, documentId?: string): KnowledgeDocument {
  const document = knowledgeDocument(value)
  if (document.id.trim() === '' || document.filename.trim() === '' || document.updatedAt.trim() === ''
    || document.knowledgeBaseId !== knowledgeBaseId || documentId !== undefined && document.id !== documentId) {
    throw new Error('Knowledge editor document does not match the requested resource')
  }
  return document
}

/** Restore suspended writes before allowing another save at the same entry.
 * @param props Current library, editor action, and commit callback.
 * @returns An employee-scoped editor or a visible recovery failure.
 */
export function KnowledgeEditor(props: KnowledgeEditorProps): ReactNode {
  const { target, knowledgeBaseId, t } = props
  const editing = target.kind === 'folder' ? target.folder !== undefined : target.kind === 'markdown' && target.document !== undefined
  const scope = JSON.stringify([knowledgeBaseId, target.kind, editing ? 'edit' : 'create', target.kind === 'folder'
    ? target.folder?.id ?? target.parentId ?? null : target.kind === 'markdown' ? target.document?.id ?? target.folderId ?? null : target.folderId ?? null])
  const recovery = useKnowledgeSaveRecovery(scope)
  if (!recovery.ready) return <Modal open title={t('knowledgeRecoveryTitle')} closeLabel={t('close')} onClose={props.onClose}>
    {recovery.error ? <><p role="alert">{t('knowledgeRecoveryFailed')}</p>
      <Button onClick={() => { void recovery.reload() }}>{t('retry')}</Button></> : <ProductLoading label={t('loading')} />}
  </Modal>
  return <KnowledgeEditorForm key={scope} {...props} restored={recovery.draft} recovery={recovery.recovery} />
}

/** Preserve content and retry identity; suspended saves can be resumed without repeating a new write.
 * @param props Current library, editor action, and commit callback.
 * @returns Text or URL editor with guarded manual-document modification.
 */
function KnowledgeEditorForm({ knowledgeBaseId, target, onClose, onSaved, t, restored, recovery }: KnowledgeEditorProps & {
  readonly restored: KnowledgeSaveDraft | undefined
  readonly recovery: ReturnType<typeof useKnowledgeSaveRecovery>['recovery']
}): ReactNode {
  const request = useKnowledgeRequests()
  const [title, setTitle] = useState(restored?.title ?? (target.kind === 'folder' ? target.folder?.name ?? '' : target.kind === 'markdown' ? target.document?.filename.replace(/\.md$/iu, '') ?? '' : ''))
  const [content, setContent] = useState(restored?.content ?? '')
  const [url, setUrl] = useState(restored?.url ?? '')
  const [parentId, setParentId] = useState(restored ? restored.parentId : target.kind === 'folder' ? target.folder?.parentId ?? target.parentId ?? null : null)
  const [parentReady, setParentReady] = useState(false)
  const [metadata, setMetadata] = useState<KnowledgeDocument | undefined>(restored?.metadata)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<KnowledgeDocument>()
  const [loading, setLoading] = useState(!restored && target.kind === 'markdown' && target.document !== undefined)
  const [pending, setPending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(restored !== undefined)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const baseline = useRef({ title, content, url, parentId })
  const suspend = async () => {
    if (!operation.current.save) return
    setPending(true)
    try {
      await recovery.suspend({ title, content, url, parentId, ...metadata ? { metadata } : {}, save: operation.current.save },
        operation.current.controller.signal)
      if (!operation.current.controller.signal.aborted) onClose()
    } catch (failure) { if (!operation.current.controller.signal.aborted) setError(productErrorMessage(failure, t, 'knowledgeRecoveryFailed')) }
    finally { if (!operation.current.controller.signal.aborted) setPending(false) }
  }
  const close = useEditorCloseGuard(!unconfirmed && (restored !== undefined || title !== baseline.current.title
    || content !== baseline.current.content
    || url !== baseline.current.url || parentId !== baseline.current.parentId), pending,
  () => {
    if (unconfirmed) { void suspend(); return }
    try { recovery.clear(); onClose() }
    catch (failure) { setError(productErrorMessage(failure, t, 'knowledgeRecoveryFailed')) }
  }, unconfirmed)
  const operation = useRef<{
    controller: AbortController
    save?: { readonly method: string; readonly payload: Readonly<Record<string, unknown>> }
  }>({ controller: new AbortController(), ...restored ? { save: restored.save } : {} })
  useEffect(() => {
    const controller = new AbortController()
    operation.current.controller = controller
    return () => { controller.abort() }
  }, [])
  useEffect(() => {
    if (target.kind !== 'markdown' || !target.document || operation.current.save) return
    const documentId = target.document.id
    const controller = new AbortController()
    setLoading(true); setError('')
    void request('knowledge.documents.get', { knowledgeBaseId, documentId }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        const document = editorDocument(value, knowledgeBaseId, documentId)
        if (document.sourceType !== 'manual' || document.canManage !== true || document.manualContent === undefined) throw new Error('Document is not editable')
        const loadedTitle = document.filename.replace(/\.md$/iu, '')
        baseline.current = { title: loadedTitle, content: document.manualContent, url: '', parentId: null }
        setMetadata(document); setTitle(loadedTitle); setContent(document.manualContent)
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(productErrorMessage(failure, t, 'knowledgeReadFailed')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, target, revision, t])
  const change = (set: (value: string) => void, value: string) => {
    if (pending || unconfirmed) return
    set(value); setError(''); delete operation.current.save
  }
  const save = async (): Promise<void> => {
    if (pending || loading || conflict || !unconfirmed && target.kind === 'folder' && !target.folder && !parentReady) return
    setPending(true); setError('')
    const operationId = operation.current.save?.payload.operationId ?? globalThis.crypto.randomUUID()
    const saveRequest = operation.current.save ??= target.kind === 'folder'
      ? { method: target.folder ? 'knowledge.folders.rename' : 'knowledge.folders.create', payload: {
        knowledgeBaseId, name: title.trim(), operationId,
        ...(target.folder ? { folderId: target.folder.id, expectedUpdatedAt: target.folder.updatedAt } : { parentId }),
      } }
      : target.kind === 'url'
        ? { method: 'knowledge.documents.importUrl', payload: { knowledgeBaseId, url: url.trim(), operationId,
          folderId: target.folderId ?? null, ...(title.trim() ? { title: title.trim() } : {}) } }
        : { method: 'knowledge.documents.save', payload: { knowledgeBaseId, title: title.trim(), content, operationId,
          ...(metadata ? { documentId: metadata.id, expectedUpdatedAt: metadata.updatedAt } : { folderId: target.folderId ?? null }) } }
    const controller = operation.current.controller
    try {
      const saved = await request(saveRequest.method, saveRequest.payload, controller.signal)
      if (controller.signal.aborted) return
      let folder: KnowledgeFolder | undefined
      try {
        if (target.kind === 'folder') {
          folder = knowledgeFolder(saved)
          if (folder.id.trim() === '' || folder.name.trim() === '' || folder.updatedAt.trim() === ''
            || target.folder && folder.id !== target.folder.id) throw new Error('Invalid folder save receipt')
        } else editorDocument(saved, knowledgeBaseId, target.kind === 'markdown' ? target.document?.id : undefined)
      } catch (_error) {
        throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Knowledge save receipt is invalid', true)
      }
      recovery.clear()
      if (folder) onSaved(folder)
      else onSaved()
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (productFailure(failure).code === 'KNOWLEDGE_DOCUMENT_CONFLICT') {
          setConflict(true); setLatest(undefined); setUnconfirmed(false)
        } else setUnconfirmed(isKnowledgeSaveUnconfirmed(failure))
        setError(productErrorMessage(failure, t, 'knowledgeSaveFailed'))
      }
    }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  const readLatest = async (): Promise<void> => {
    if (!metadata || loading || pending) return
    const controller = operation.current.controller
    setLoading(true); setError(''); setLatest(undefined)
    try {
      const document = editorDocument(await request('knowledge.documents.get', {
        knowledgeBaseId, documentId: metadata.id,
      }, controller.signal), knowledgeBaseId, metadata.id)
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
  const valid = (unconfirmed || target.kind !== 'folder' || target.folder !== undefined || parentReady)
    && (target.kind === 'url' ? validUrl : title.trim() !== '' && (target.kind === 'folder' || content.trim() !== ''))
  const editable = target.kind !== 'markdown' || target.document === undefined || metadata !== undefined
  return <Modal open title={t(titleKey)} closeLabel={t('close')} onClose={close.requestClose}
    className={(target.kind === 'folder' ? css.knowledgeBaseEditorModal : css.knowledgeEditorModal) as string}
    contentClassName={css.knowledgeEditorContent as string} footer={<>
      {close.confirming ? <>
        <Button variant="ghost" size="sm" onClick={close.keepEditing}>{t('knowledgeKeepEditing')}</Button>
        <Button variant="primary" size="sm" onClick={close.discard}>{t('knowledgeDiscardDraft')}</Button>
      </> : <>
        <Button variant="ghost" size="sm" disabled={pending} onClick={close.requestClose}>{t(unconfirmed ? 'knowledgeSuspendSave' : 'cancel')}</Button>
        <Button variant="primary" size="sm" disabled={pending || loading || conflict || !valid || !editable} onClick={() => { void save() }}>{t(pending ? 'saving' : unconfirmed ? 'knowledgeRetrySave' : 'knowledgeSave')}</Button>
      </>}
    </>}>
    {close.confirming ? <p>{t('knowledgeDiscardDraftConfirmation')}</p> : <form className={css.knowledgeEditorForm} onSubmit={(event) => { event.preventDefault(); if (valid && editable) void save() }}>
      <label>{t(target.kind === 'folder' ? 'knowledgeFolderName' : 'knowledgeDocumentTitle')}
        <input data-modal-autofocus value={title} maxLength={target.kind === 'folder' ? 80 : 120} disabled={pending || loading || unconfirmed}
          onChange={(event) => { change(setTitle, event.currentTarget.value) }} /></label>
      {target.kind === 'folder' && !target.folder && <KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId}
        label={t('knowledgeParentFolder')} value={parentId} disabled={pending || unconfirmed} onReady={setParentReady}
        onChange={(id) => { if (pending || unconfirmed) return; setParentId(id); setParentReady(false); setError(''); delete operation.current.save }} t={t} />}
      {target.kind === 'url' && <label>{t('knowledgeWebsiteUrl')}<input value={url} type="url" maxLength={2_000} disabled={pending || unconfirmed}
        onChange={(event) => { change(setUrl, event.currentTarget.value) }} /></label>}
      {target.kind === 'markdown' && <label>{t('knowledgeMarkdownContent')}<textarea value={content} disabled={pending || loading || unconfirmed || !editable}
        onChange={(event) => { change(setContent, event.currentTarget.value) }} /></label>}
      {loading && <ProductLoading label={t('loading')} />}
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {unconfirmed && <p role="status" className={css.catalogStatus}>{t('knowledgeSaveUnconfirmed')}</p>}
      {close.blocked && pending && <p role="status" className={css.catalogStatus}>{t('knowledgeWaitForSave')}</p>}
      {conflict && <>
        <p>{t('knowledgeConflictDraftRetained')}</p>
        <Button variant="outline" size="sm" disabled={loading || pending} onClick={() => { void readLatest() }}>{t('knowledgeReadLatest')}</Button>
        {latest && <>
          <details><summary>{t('knowledgeLatestVersion')}</summary><p>{latest.filename}</p>
            <textarea readOnly aria-label={t('knowledgeLatestVersion')} value={latest.manualContent ?? ''} /></details>
          <Button variant="outline" size="sm" disabled={loading || pending} onClick={() => {
            setMetadata(latest); setConflict(false); setLatest(undefined); setError(''); delete operation.current.save
          }}>{t('knowledgeContinueDraft')}</Button>
        </>}
      </>}
      {!loading && !editable && <Button variant="outline" size="sm" onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</Button>}
    </form>}
  </Modal>
}
