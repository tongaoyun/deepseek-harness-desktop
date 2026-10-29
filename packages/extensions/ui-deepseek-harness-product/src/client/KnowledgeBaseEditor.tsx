import { ProductLoading } from './ProductLoading.tsx'
/** Create a personal library using ownership computed by the server. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProductError } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { ProductCatalogSchema } from '@deepseek-harness/product/catalog'
import { useKnowledgeRequests } from './knowledge-data.ts'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useKnowledgeSaveRecovery, type KnowledgeSaveDraft } from './knowledge-save-recovery.ts'
import { KnowledgeEditorFooter } from './KnowledgeEditorFooter.tsx'

interface KnowledgeBaseEditorProps {
  readonly onClose: () => void
  readonly onCreated: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}

/** Preserve the name and request identity after a failed personal-library creation.
 * @param props Dismissal, committed library selection, and locale dictionary.
 * @returns A compact name form with cancellable server creation.
 */
export function KnowledgeBaseEditor(props: KnowledgeBaseEditorProps): ReactNode {
  const recovery = useKnowledgeSaveRecovery('personal-library')
  const { t } = props
  if (!recovery.ready) return <Modal open title={t('knowledgeRecoveryTitle')} closeLabel={t('close')} onClose={props.onClose}>
    {recovery.error ? <><p role="alert">{t('knowledgeRecoveryFailed')}</p>
      <Button onClick={() => { void recovery.reload() }}>{t('retry')}</Button></> : <ProductLoading label={t('loading')} />}
  </Modal>
  return <KnowledgeBaseEditorForm {...props} restored={recovery.draft} recovery={recovery.recovery} />
}

function KnowledgeBaseEditorForm({ onClose, onCreated, t, restored, recovery }: KnowledgeBaseEditorProps & {
  readonly restored: KnowledgeSaveDraft | undefined
  readonly recovery: ReturnType<typeof useKnowledgeSaveRecovery>['recovery']
}): ReactNode {
  const request = useKnowledgeRequests()
  const [name, setName] = useState(restored?.title ?? '')
  const [pending, setPending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(restored !== undefined)
  const [error, setError] = useState('')
  const suspend = async () => {
    if (!operation.current.payload) return
    setPending(true)
    try {
      await recovery.suspend({ title: name, content: '', url: '', parentId: null,
        save: { method: 'knowledge.bases.create', payload: operation.current.payload } }, operation.current.controller.signal)
      if (!operation.current.controller.signal.aborted) onClose()
    } catch (failure) { if (!operation.current.controller.signal.aborted) setError(productErrorMessage(failure, t, 'knowledgeRecoveryFailed')) }
    finally { if (!operation.current.controller.signal.aborted) setPending(false) }
  }
  const close = useEditorCloseGuard(!unconfirmed && name !== '', pending,
    () => {
      if (unconfirmed) { void suspend(); return }
      try { recovery.clear(); onClose() }
      catch (failure) { setError(productErrorMessage(failure, t, 'knowledgeRecoveryFailed')) }
    }, unconfirmed)
  const operation = useRef<{ controller: AbortController; payload?: Readonly<Record<string, unknown>> }>({
    controller: new AbortController(), ...restored ? { payload: restored.save.payload } : {},
  })
  useEffect(() => {
    const controller = new AbortController()
    operation.current.controller = controller
    return () => { controller.abort() }
  }, [])
  const save = async (): Promise<void> => {
    if (pending || name.trim() === '') return
    setPending(true); setError('')
    const payload = operation.current.payload ??= { name: name.trim(), description: '', operationId: globalThis.crypto.randomUUID() }
    const controller = operation.current.controller
    try {
      const response = await request('knowledge.bases.create', payload, controller.signal)
      if (controller.signal.aborted) return
      const receipt = ProductCatalogSchema.safeParse([response])
      const base = receipt.success ? receipt.data[0] : undefined
      if (base === undefined) {
        throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Personal library save receipt is invalid', true)
      }
      recovery.clear()
      onCreated(base.id)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setUnconfirmed(isKnowledgeSaveUnconfirmed(failure))
        setError(productErrorMessage(failure, t, 'knowledgeCreateBaseFailed'))
      }
    }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  return <Modal open title={t('knowledgeCreatePersonalBase')} closeLabel={t('close')} onClose={close.requestClose}
    className={css.knowledgeBaseEditorModal as string} footer={<KnowledgeEditorFooter close={close} pending={pending}
      disabled={name.trim() === ''} unconfirmed={unconfirmed} saveKey="knowledgeCreate" t={t} onSave={() => { void save() }} />}>{close.confirming ? <p>{t('knowledgeDiscardDraftConfirmation')}</p> : <form className={css.knowledgeEditorForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>{t('knowledgeBaseName')}<input data-modal-autofocus value={name} maxLength={120} disabled={pending || unconfirmed}
        onChange={(event) => { if (pending || unconfirmed) return; setName(event.currentTarget.value); setError(''); delete operation.current.payload }} /></label>
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {unconfirmed && <p role="status" className={css.catalogStatus}>{t('knowledgeSaveUnconfirmed')}</p>}
      {close.blocked && pending && <p role="status" className={css.catalogStatus}>{t('knowledgeWaitForSave')}</p>}
    </form>}</Modal>
}
