import { ProductLoading } from './ProductLoading.tsx'
/** Manual documents, website imports, and folders use explicit idempotent save operations. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { knowledgeDocument, knowledgeFolder, useKnowledgeRequests, type KnowledgeDocument, type KnowledgeFolder } from './knowledge-data.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { isKnowledgeSaveUnconfirmed, productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useKnowledgeSaveRecovery } from './knowledge-save-recovery.ts'
import { KnowledgeEditorFooter } from './KnowledgeEditorFooter.tsx'
import { confirmKnowledgeDocumentWrite } from './knowledge-mutation-receipts.ts'
import { KnowledgeDestination } from './KnowledgeDestination.tsx'
import { useResultFocus } from './useResultFocus.ts'

/** A manager's create or edit action captured before opening the form. */
export type KnowledgeEditorTarget = { readonly kind: 'markdown'; readonly document?: KnowledgeDocument; readonly folderId?: string | null }
  | { readonly kind: 'url'; readonly folderId?: string | null } | { readonly kind: 'folder'; readonly folder?: KnowledgeFolder; readonly parentId?: string | null }

interface KnowledgeEditorProps {
  readonly knowledgeBaseId: string
  readonly libraryName?: string
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

/** Restore suspended writes within the same dialog before allowing another save at the same entry.
 * @param props Current library, editor action, and commit callback.
 * @returns An employee-scoped editor or a visible recovery failure.
 */
export function KnowledgeEditor(props: KnowledgeEditorProps): ReactNode {
  const { target, knowledgeBaseId } = props
  const editing = target.kind === 'folder' ? target.folder !== undefined : target.kind === 'markdown' && target.document !== undefined
  const scope = JSON.stringify([knowledgeBaseId, target.kind, editing ? 'edit' : 'create', target.kind === 'folder'
    ? target.folder?.id ?? target.parentId ?? null : target.kind === 'markdown' ? target.document?.id ?? target.folderId ?? null : target.folderId ?? null])
  const form = useRef<HTMLFormElement>(null)
  const captureReadFocus = useResultFocus(form, form)
  const recovery = useKnowledgeSaveRecovery(scope, captureReadFocus)
  return <KnowledgeEditorForm key={scope} {...props} recovery={recovery} formRef={form} />
}

/** Preserve content and retry identity; suspended saves can be resumed without repeating a new write.
 * @param props Current library, editor action, and commit callback.
 * @returns Text or URL editor with guarded manual-document modification.
 */
function KnowledgeEditorForm({ knowledgeBaseId, libraryName, target, onClose, onSaved, t,
  recovery: recoveryState, formRef }: KnowledgeEditorProps & {
    readonly recovery: ReturnType<typeof useKnowledgeSaveRecovery>
    readonly formRef: RefObject<HTMLFormElement>
  }): ReactNode {
  const restored = recoveryState.draft
  const recovery = recoveryState.recovery
  const captureReadFocus = useResultFocus(formRef, formRef)
  const request = useKnowledgeRequests()
  const urlHintId = useId()
  const urlErrorId = useId()
  const [title, setTitle] = useState(restored?.title ?? (target.kind === 'folder' ? target.folder?.name ?? '' : target.kind === 'markdown' ? target.document?.filename.replace(/\.md$/iu, '') ?? '' : ''))
  const [content, setContent] = useState(restored?.content ?? '')
  const [url, setUrl] = useState(restored?.url ?? '')
  const [parentId, setParentId] = useState(restored ? restored.parentId : target.kind === 'folder' ? target.folder?.parentId ?? target.parentId ?? null : null)
  const [parentReady, setParentReady] = useState(false)
  const [metadata, setMetadata] = useState<KnowledgeDocument | undefined>(restored?.metadata)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<KnowledgeDocument>()
  const [loading, setLoading] = useState(!restored && target.kind === 'markdown' && target.document !== undefined)
  const [pendingAction, setPendingAction] = useState<false | 'save' | 'suspend'>(false)
  const pending = pendingAction !== false
  const [unconfirmed, setUnconfirmed] = useState(restored !== undefined)
  const [error, setError] = useState<ProductFailureReport>()
  const [revision, setRevision] = useState(0)
  const operation = useRef<{
    controller: AbortController
    active?: 'save' | 'suspend' | 'review'
    save?: { readonly method: string; readonly payload: Readonly<Record<string, unknown>> }
  }>({ controller: new AbortController(), ...restored ? { save: restored.save } : {} })
  const baseline = useRef({ title, content, url, parentId })
  useLayoutEffect(() => {
    if (!restored) return
    setTitle(restored.title); setContent(restored.content); setUrl(restored.url); setParentId(restored.parentId)
    setMetadata(restored.metadata); setUnconfirmed(true); setLoading(false)
    operation.current.save = restored.save
  }, [restored])
  const suspend = async () => {
    if (!operation.current.save || operation.current.active !== undefined) return
    operation.current.active = 'suspend'
    setPendingAction('suspend')
    try {
      await recovery.suspend({ title, content, url, parentId, ...metadata ? { metadata } : {}, save: operation.current.save },
        operation.current.controller.signal)
      if (!operation.current.controller.signal.aborted) onClose()
    } catch (failure) { if (!operation.current.controller.signal.aborted) setError({ failure, fallback: 'knowledgeRecoveryFailed' }) }
    finally { delete operation.current.active; if (!operation.current.controller.signal.aborted) setPendingAction(false) }
  }
  const close = useEditorCloseGuard(!unconfirmed && (restored !== undefined || title !== baseline.current.title
    || content !== baseline.current.content
    || url !== baseline.current.url || parentId !== baseline.current.parentId), () => operation.current.active !== undefined && operation.current.active !== 'review',
  () => {
    if (unconfirmed) { void suspend(); return }
    try { recovery.clear(); onClose() }
    catch (failure) { setError({ failure, fallback: 'knowledgeRecoveryFailed' }) }
  }, unconfirmed)
  useEffect(() => {
    const controller = new AbortController()
    operation.current.controller = controller
    return () => { controller.abort() }
  }, [])
  useEffect(() => {
    if (!recoveryState.ready || target.kind !== 'markdown' || !target.document || operation.current.save) return
    const documentId = target.document.id
    const controller = new AbortController()
    setLoading(true)
    void request('knowledge.documents.get', { knowledgeBaseId, documentId }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        const document = editorDocument(value, knowledgeBaseId, documentId)
        if (document.sourceType !== 'manual' || document.canManage !== true || document.manualContent === undefined) throw new Error('Document is not editable')
        const loadedTitle = document.filename.replace(/\.md$/iu, '')
        captureReadFocus()
        baseline.current = { title: loadedTitle, content: document.manualContent, url: '', parentId: null }
        setMetadata(document); setTitle(loadedTitle); setContent(document.manualContent)
        setError(undefined); setLoading(false)
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) { captureReadFocus(); setError({ failure, fallback: 'knowledgeReadFailed' }); setLoading(false) }
      })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, target, revision, recoveryState.ready, captureReadFocus])
  const change = (set: (value: string) => void, value: string) => {
    if (operation.current.active !== undefined || unconfirmed) return
    set(value); setError(undefined); delete operation.current.save
  }
  const save = async (): Promise<void> => {
    if (operation.current.active !== undefined || loading || conflict || !unconfirmed && target.kind === 'folder' && !target.folder && !parentReady) return
    operation.current.active = 'save'
    setPendingAction('save')
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
          if (folder.id.trim() === '' || folder.name !== saveRequest.payload.name || !Number.isFinite(Date.parse(folder.updatedAt))
            || folder.parentId !== (target.folder?.parentId ?? saveRequest.payload.parentId ?? null)
            || target.folder && folder.id !== target.folder.id) throw new Error('Invalid folder save receipt')
        } else confirmKnowledgeDocumentWrite(saved, { knowledgeBaseId,
          documentId: target.kind === 'markdown' ? target.document?.id : undefined,
          folderId: metadata === undefined ? target.folderId ?? null : metadata.folderId ?? null })
      } catch (_error) {
        throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Knowledge save receipt is invalid', true)
      }
      recovery.clear()
      setError(undefined)
      if (folder) onSaved(folder)
      else onSaved()
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (productFailure(failure).code === 'KNOWLEDGE_DOCUMENT_CONFLICT') {
          setConflict(true); setLatest(undefined); setUnconfirmed(false)
        } else setUnconfirmed(isKnowledgeSaveUnconfirmed(failure))
        setError({ failure, fallback: 'knowledgeSaveFailed' })
      }
    }
    finally { delete operation.current.active; if (!controller.signal.aborted) setPendingAction(false) }
  }
  const readLatest = async (): Promise<void> => {
    if (!metadata || loading || operation.current.active !== undefined) return
    operation.current.active = 'review'
    const controller = operation.current.controller
    setLoading(true)
    try {
      const document = editorDocument(await request('knowledge.documents.get', {
        knowledgeBaseId, documentId: metadata.id,
      }, controller.signal), knowledgeBaseId, metadata.id)
      controller.signal.throwIfAborted()
      if (document.sourceType !== 'manual' || document.canManage !== true || document.manualContent === undefined) {
        throw new ProductError('KNOWLEDGE_MANAGEMENT_FORBIDDEN', 'Document is not editable')
      }
      captureReadFocus()
      setLatest(document)
      setError(undefined)
    } catch (failure) {
      if (!controller.signal.aborted) { captureReadFocus(); setLatest(undefined); setError({ failure, fallback: 'knowledgeReadFailed' }) }
    }
    finally { delete operation.current.active; if (!controller.signal.aborted) setLoading(false) }
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
  if (!recoveryState.ready) return <Modal open title={t('knowledgeRecoveryTitle')} closeLabel={t('close')} onClose={onClose}>
    <form ref={formRef} tabIndex={-1} aria-label={t('knowledgeRecoveryTitle')}>
      {recoveryState.error ? <><p role="alert">{t('knowledgeRecoveryFailed')}</p>
        <Button aria-disabled={recoveryState.loading} aria-busy={recoveryState.loading} className={recoveryState.loading ? 'product-control-pending' : undefined}
          onClick={() => { void recoveryState.reload() }}>{t('retry')}</Button></> : <ProductLoading label={t('loading')} />}
    </form>
  </Modal>
  return <Modal open title={t(titleKey)} closeLabel={t('close')} onClose={close.requestClose}
    className={(target.kind === 'folder' ? css.knowledgeBaseEditorModal : css.knowledgeEditorModal) as string}
    contentClassName={css.knowledgeEditorContent as string} footer={<KnowledgeEditorFooter close={close} pending={pendingAction}
      loading={loading} disabled={conflict || !valid || !editable} unconfirmed={unconfirmed}
      saveKey={target.kind === 'url' ? 'knowledgeStartImport' : 'knowledgeSave'} pendingKey={target.kind === 'url' ? 'knowledgeImporting' : 'saving'}
      t={t} onSave={() => { void save() }} />}>
    {close.confirming && <p>{t('knowledgeDiscardDraftConfirmation')}</p>}
    <div hidden={close.confirming} {...close.editorProps}>
      <form ref={formRef} tabIndex={-1} aria-label={t(titleKey)} className={css.knowledgeEditorForm}
        onSubmit={(event) => { event.preventDefault(); if (valid && editable) void save() }}>
        <KnowledgeDestination knowledgeBaseId={knowledgeBaseId} libraryName={libraryName} folderId={target.kind === 'folder'
          ? target.folder?.parentId ?? parentId : target.kind === 'markdown' && target.document ? target.document.folderId : target.folderId} t={t} />
        {target.kind === 'url' && <>
          <label>{t('knowledgeWebsiteUrl')}<input data-modal-autofocus value={url} type="url" maxLength={2_000} disabled={pending || unconfirmed}
            aria-describedby={`${urlHintId}${url !== '' && !validUrl ? ` ${urlErrorId}` : ''}`} aria-invalid={url !== '' && !validUrl || undefined}
            onChange={(event) => { change(setUrl, event.currentTarget.value) }} /></label>
          <p id={urlHintId} className={css.knowledgeBrowseHint}>{t('knowledgeImportUrlHint')}</p>
          {url !== '' && !validUrl && <p id={urlErrorId} className={css.catalogError}>{t('knowledgeImportUrlInvalid')}</p>}
        </>}
        <label>{t(target.kind === 'folder' ? 'knowledgeFolderName' : target.kind === 'url' ? 'knowledgeOptionalTitle' : 'knowledgeDocumentTitle')}
          <input data-modal-autofocus={target.kind === 'url' ? undefined : true} value={title} maxLength={target.kind === 'folder' ? 80 : 120} disabled={pending || loading || unconfirmed}
            onChange={(event) => { change(setTitle, event.currentTarget.value) }} /></label>
        {target.kind === 'folder' && !target.folder && <KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId}
          label={t('knowledgeParentFolder')} value={parentId} disabled={unconfirmed} pending={pending} onReady={setParentReady}
          onChange={(id) => {
            if (operation.current.active !== undefined || unconfirmed) return
            setParentId(id); setParentReady(false); setError(undefined); delete operation.current.save
          }} t={t} />}
        {target.kind === 'markdown' && <label>{t('knowledgeMarkdownContent')}<textarea value={content} disabled={pending || loading || unconfirmed || !editable}
          onChange={(event) => { change(setContent, event.currentTarget.value) }} /></label>}
        {loading && !error && !latest && <ProductLoading label={t('loading')} />}
        {error && <p role="alert" className={css.catalogError}>{productErrorMessage(error.failure, t, error.fallback)}</p>}
        {unconfirmed && <p role="status" className={css.catalogStatus}>{t('knowledgeSaveUnconfirmed')}</p>}
        {close.blocked && pending && <p role="status" className={css.catalogStatus}>{t('knowledgeWaitForSave')}</p>}
        {conflict && <>
          <p>{t('knowledgeConflictDraftRetained')}</p>
          <Button variant="outline" size="sm" aria-disabled={loading || pending} aria-busy={loading}
            className={loading || pending ? 'product-control-pending' : undefined} onClick={() => { void readLatest() }}>{t('knowledgeReadLatest')}</Button>
          {latest && <>
            <details><summary>{t('knowledgeLatestVersion')}</summary><p>{latest.filename}</p>
              <textarea readOnly aria-label={t('knowledgeLatestVersion')} value={latest.manualContent ?? ''} /></details>
            <Button variant="outline" size="sm" disabled={loading || pending} onClick={() => {
              if (operation.current.active !== undefined) return
              captureReadFocus()
              setMetadata(latest); setConflict(false); setLatest(undefined); setError(undefined); delete operation.current.save
            }}>{t('knowledgeContinueDraft')}</Button>
          </>}
        </>}
        {!editable && (!loading || error !== undefined) && <Button variant="outline" size="sm" aria-disabled={loading} aria-busy={loading}
          className={loading ? 'product-control-pending' : undefined} onClick={() => {
            if (loading) return
            setLoading(true); setRevision(value => value === revision ? value + 1 : value)
          }}>{t('retry')}</Button>}
      </form></div>
  </Modal>
}
