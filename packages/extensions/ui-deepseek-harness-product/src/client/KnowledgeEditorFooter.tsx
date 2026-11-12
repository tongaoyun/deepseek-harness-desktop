import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import type { useEditorCloseGuard } from './useEditorCloseGuard.ts'

type CloseGuard = ReturnType<typeof useEditorCloseGuard>

/** Knowledge editors retain action focus and distinguish save progress from draft suspension. */
export function KnowledgeEditorFooter(props: {
  close: CloseGuard
  pending: false | 'save' | 'suspend'
  loading?: boolean
  disabled?: boolean
  unconfirmed: boolean
  saveKey: DeepSeekHarnessProductKey
  pendingKey?: DeepSeekHarnessProductKey
  t: (key: DeepSeekHarnessProductKey) => string
  onSave: () => void
}): ReactNode {
  const { close, pending: action, loading = false, disabled = false, unconfirmed, saveKey, pendingKey = 'saving', t, onSave } = props
  const pending = action !== false
  return close.confirming ? <>
    <Button ref={close.keepEditingRef} variant="ghost" size="sm" onClick={close.keepEditing}>{t('knowledgeKeepEditing')}</Button>
    <Button variant="primary" size="sm" onClick={close.discard}>{t('knowledgeDiscardDraft')}</Button>
  </> : <>
    <Button variant="ghost" size="sm" aria-disabled={pending} aria-busy={action === 'suspend'} className={pending ? 'product-control-pending' : undefined}
      onClick={close.requestClose}>{t(unconfirmed ? 'knowledgeSuspendSave' : 'cancel')}</Button>
    <Button variant="primary" size="sm" disabled={loading || disabled} aria-disabled={pending || loading || disabled} aria-busy={action === 'save'}
      className={!disabled && (pending || loading) ? 'product-control-pending' : undefined}
      onClick={() => { if (!pending && !loading && !disabled) onSave() }}>{t(action === 'save' ? pendingKey : unconfirmed ? 'knowledgeRetrySave' : saveKey)}</Button>
  </>
}
