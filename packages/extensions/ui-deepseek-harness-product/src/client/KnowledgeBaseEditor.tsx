/** Create a personal library using ownership computed by the server. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { items } from './catalog-shared.tsx'
import { useKnowledgeRequests } from './knowledge-data.ts'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'

/** Preserve the name and request identity after a failed personal-library creation.
 * @param props Dismissal, committed library selection, and locale dictionary.
 * @returns A compact name form with cancellable server creation.
 */
export function KnowledgeBaseEditor({ onClose, onCreated, t }: {
  readonly onClose: () => void
  readonly onCreated: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef<{ controller: AbortController; payload?: Readonly<Record<string, unknown>> }>({
    controller: new AbortController(),
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
      const base = items([response])[0]
      if (base === undefined) throw new Error('Invalid personal library response')
      onCreated(base.id)
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (isKnowledgeSaveUnconfirmed(failure)) setUnconfirmed(true)
        setError(productErrorMessage(failure, t, 'knowledgeCreateBaseFailed'))
      }
    }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  return <Modal open title={t('knowledgeCreatePersonalBase')} closeLabel={t('close')} onClose={onClose}
    className={css.knowledgeBaseEditorModal as string} footer={<>
      <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" size="sm" disabled={pending || name.trim() === ''} onClick={() => { void save() }}>{t(pending ? 'saving' : unconfirmed ? 'knowledgeRetrySave' : 'knowledgeCreate')}</Button>
    </>}><form className={css.knowledgeEditorForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>{t('knowledgeBaseName')}<input data-modal-autofocus value={name} maxLength={120} disabled={pending || unconfirmed}
        onChange={(event) => { if (pending || unconfirmed) return; setName(event.currentTarget.value); setError(''); delete operation.current.payload }} /></label>
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {unconfirmed && <p role="status" className={css.catalogStatus}>{t('knowledgeSaveUnconfirmed')}</p>}
    </form></Modal>
}
