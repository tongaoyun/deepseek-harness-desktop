/** Create a personal library or edit authorized library details. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProductError } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { ProductCatalogSchema } from '@deepseek-harness/product/catalog'
import { useKnowledgeRequests } from './knowledge-data.ts'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useKnowledgeSaveRecovery } from './knowledge-save-recovery.ts'
import { KnowledgeEditorFooter } from './KnowledgeEditorFooter.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { useResultFocus } from './useResultFocus.ts'

interface KnowledgeBaseEditorProps {
  readonly knowledgeBaseId?: string
  readonly onClose: () => void
  readonly onSaved: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}

/** Preserve the dialog, edited details, and request identity through reads and unconfirmed saves.
 * @param props Dismissal, committed library selection, and locale dictionary.
 * @returns A permission-checked details form with cancellable save and recovery.
 */
export function KnowledgeBaseEditor(props: KnowledgeBaseEditorProps): ReactNode {
  const form = useRef<HTMLFormElement>(null)
  const captureReadFocus = useResultFocus(form, form)
  const recovery = useKnowledgeSaveRecovery(props.knowledgeBaseId === undefined ? 'personal-library' : `library-update:${props.knowledgeBaseId}`, captureReadFocus)
  const { knowledgeBaseId } = props
  const request = useKnowledgeRequests()
  const [baseline, setBaseline] = useState<{ name: string; description: string; updatedAt: string }>()
  const [readError, setReadError] = useState<unknown>()
  const [reading, setReading] = useState(knowledgeBaseId !== undefined)
  const [revision, setRevision] = useState(0)
  useEffect(() => { setBaseline(undefined); setReadError(undefined) }, [knowledgeBaseId, request])
  useEffect(() => {
    if (knowledgeBaseId === undefined) return
    const controller = new AbortController()
    setReading(true)
    void request('knowledge.bases.get', { knowledgeBaseId }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      const item = ProductCatalogSchema.parse([value])[0]
      if (item?.id !== knowledgeBaseId || item.canManage !== true || !item.updatedAt || !Number.isFinite(Date.parse(item.updatedAt))) {
        throw new Error('Library editing is unavailable')
      }
      captureReadFocus()
      setBaseline({ name: item.label, description: item.description ?? '', updatedAt: item.updatedAt })
      setReadError(undefined)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) { captureReadFocus(); setReadError(failure) }
    }).finally(() => { if (!controller.signal.aborted) setReading(false) })
    return () => { controller.abort() }
  }, [knowledgeBaseId, request, revision, captureReadFocus])
  return <KnowledgeBaseEditorForm {...props} baseline={baseline} readError={readError} reading={reading}
    formRef={form} recovery={recovery} onRetry={() => {
      if (reading) return
      setReading(true); setRevision(value => value === revision ? revision + 1 : value)
    }} />
}

function KnowledgeBaseEditorForm({ knowledgeBaseId, onClose, onSaved, t, recovery: recoveryState, baseline,
  readError, reading, onRetry, formRef }: KnowledgeBaseEditorProps & {
    readonly baseline: { name: string; description: string; updatedAt: string } | undefined
    readonly readError: unknown
    readonly reading: boolean
    readonly onRetry: () => void
    readonly formRef: RefObject<HTMLFormElement>
    readonly recovery: ReturnType<typeof useKnowledgeSaveRecovery>
  }): ReactNode {
  const restored = recoveryState.draft
  const recovery = recoveryState.recovery
  const request = useKnowledgeRequests()
  const [name, setName] = useState(restored?.title ?? baseline?.name ?? '')
  const [description, setDescription] = useState(restored?.content ?? baseline?.description ?? '')
  const method = knowledgeBaseId === undefined ? 'knowledge.bases.create' : 'knowledge.bases.update'
  const [pendingAction, setPendingAction] = useState<false | 'save' | 'suspend'>(false)
  const pending = pendingAction !== false
  const [unconfirmed, setUnconfirmed] = useState(restored !== undefined)
  const [error, setError] = useState<{ readonly failure: unknown; readonly fallback: DeepSeekHarnessProductKey }>()
  const operation = useRef<{ controller: AbortController; active: boolean; payload?: Readonly<Record<string, unknown>> }>({
    controller: new AbortController(), active: false, ...restored ? { payload: restored.save.payload } : {},
  })
  useLayoutEffect(() => {
    setName(restored?.title ?? baseline?.name ?? '')
    setDescription(restored?.content ?? baseline?.description ?? '')
    setUnconfirmed(restored !== undefined)
    if (restored) operation.current.payload = restored.save.payload
  }, [baseline, restored])
  const suspend = async () => {
    if (!operation.current.payload || operation.current.active) return
    operation.current.active = true
    setPendingAction('suspend')
    try {
      await recovery.suspend({ title: name, content: description, url: '', parentId: null,
        save: { method, payload: operation.current.payload } }, operation.current.controller.signal)
      if (!operation.current.controller.signal.aborted) onClose()
    } catch (failure) { if (!operation.current.controller.signal.aborted) setError({ failure, fallback: 'knowledgeRecoveryFailed' }) }
    finally { operation.current.active = false; if (!operation.current.controller.signal.aborted) setPendingAction(false) }
  }
  const close = useEditorCloseGuard(!unconfirmed && (name !== (baseline?.name ?? '') || description !== (baseline?.description ?? '')), () => operation.current.active,
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
  const save = async (): Promise<void> => {
    if (operation.current.active || name.trim() === '') return
    operation.current.active = true
    setPendingAction('save')
    const payload = operation.current.payload ??= { name: name.trim(), description: description.trim(),
      operationId: globalThis.crypto.randomUUID(),
      ...knowledgeBaseId === undefined ? {} : { knowledgeBaseId, expectedUpdatedAt: baseline?.updatedAt } }
    const controller = operation.current.controller
    try {
      const response = await request(method, payload, controller.signal)
      if (controller.signal.aborted) return
      const receipt = ProductCatalogSchema.safeParse([response])
      const base = receipt.success ? receipt.data[0] : undefined
      if (base === undefined || base.label !== payload.name || (base.description ?? '') !== payload.description
        || base.canManage !== true || !base.updatedAt || !Number.isFinite(Date.parse(base.updatedAt))
        || (knowledgeBaseId === undefined ? base.scope !== 'PERSONAL' : base.id !== knowledgeBaseId)) {
        throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Personal library save receipt is invalid', true)
      }
      recovery.clear()
      setError(undefined)
      onSaved(base.id)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setUnconfirmed(isKnowledgeSaveUnconfirmed(failure))
        setError({ failure, fallback: knowledgeBaseId === undefined ? 'knowledgeCreateBaseFailed' : 'knowledgeUpdateBaseFailed' })
      }
    }
    finally { operation.current.active = false; if (!controller.signal.aborted) setPendingAction(false) }
  }
  if (knowledgeBaseId !== undefined && baseline === undefined) return <Modal open title={t('knowledgeEditBase')} closeLabel={t('close')} onClose={onClose}
    className={css.knowledgeBaseEditorModal as string}>
    <form ref={formRef} tabIndex={-1} aria-label={t('knowledgeEditBase')}>
      {readError !== undefined ? <div className={css.knowledgeSelectionError}>
        <p role="alert" className={css.catalogError}>{productErrorMessage(readError, t, 'knowledgeBaseReadFailed')}</p>
        <Button variant="outline" size="sm" aria-disabled={reading} aria-busy={reading} className={reading ? 'product-control-pending' : undefined}
          onClick={onRetry}>{t('retry')}</Button>
      </div> : <ProductLoading label={t('loading')} />}
    </form>
  </Modal>
  if (!recoveryState.ready) return <Modal open title={t('knowledgeRecoveryTitle')} closeLabel={t('close')} onClose={onClose}>
    <form ref={formRef} tabIndex={-1} aria-label={t('knowledgeRecoveryTitle')}>
      {recoveryState.error ? <><p role="alert">{t('knowledgeRecoveryFailed')}</p>
        <Button aria-disabled={recoveryState.loading} aria-busy={recoveryState.loading} className={recoveryState.loading ? 'product-control-pending' : undefined}
          onClick={() => { void recoveryState.reload() }}>{t('retry')}</Button></> : <ProductLoading label={t('loading')} />}
    </form>
  </Modal>
  if (restored && (restored.save.method !== (knowledgeBaseId === undefined ? 'knowledge.bases.create' : 'knowledge.bases.update')
    || knowledgeBaseId !== undefined && restored.save.payload.knowledgeBaseId !== knowledgeBaseId)) {
    return <Modal open title={t('knowledgeRecoveryTitle')} closeLabel={t('close')} onClose={onClose}>
      <form ref={formRef} tabIndex={-1} aria-label={t('knowledgeRecoveryTitle')}><p role="alert">{t('knowledgeRecoveryFailed')}</p></form>
    </Modal>
  }
  return <Modal open title={t(knowledgeBaseId === undefined ? 'knowledgeCreatePersonalBase' : 'knowledgeEditBase')} closeLabel={t('close')} onClose={close.requestClose}
    className={css.knowledgeBaseEditorModal as string} footer={<KnowledgeEditorFooter close={close} pending={pendingAction}
      disabled={name.trim() === ''} unconfirmed={unconfirmed} saveKey={knowledgeBaseId === undefined ? 'knowledgeCreate' : 'knowledgeSave'} t={t} onSave={() => { void save() }} />}>
    {close.confirming && <p>{t('knowledgeDiscardDraftConfirmation')}</p>}
    <div hidden={close.confirming} {...close.editorProps}>
      <form ref={formRef} tabIndex={-1} aria-label={t(knowledgeBaseId === undefined ? 'knowledgeCreatePersonalBase' : 'knowledgeEditBase')}
        className={css.knowledgeEditorForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
        <label>{t('knowledgeBaseName')}<input data-modal-autofocus value={name} maxLength={120} disabled={pending || unconfirmed}
          onChange={(event) => {
            if (operation.current.active || unconfirmed) return
            setName(event.currentTarget.value); setError(undefined); delete operation.current.payload
          }} /></label>
        <label>{t('knowledgeBaseDescription')}<textarea value={description} maxLength={1000} rows={4} disabled={pending || unconfirmed}
          onChange={(event) => {
            if (operation.current.active || unconfirmed) return
            setDescription(event.currentTarget.value); setError(undefined); delete operation.current.payload
          }} /></label>
        {error !== undefined && <p role="alert" className={css.catalogError}>{productErrorMessage(error.failure, t, error.fallback)}</p>}
        {unconfirmed && <p role="status" className={css.catalogStatus}>{t('knowledgeSaveUnconfirmed')}</p>}
        {close.blocked && pending && <p role="status" className={css.catalogStatus}>{t('knowledgeWaitForSave')}</p>}
      </form></div></Modal>
}
