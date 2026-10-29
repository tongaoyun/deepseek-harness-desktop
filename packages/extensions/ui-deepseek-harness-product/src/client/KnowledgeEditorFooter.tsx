import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import type { useEditorCloseGuard } from './useEditorCloseGuard.ts'

type CloseGuard = ReturnType<typeof useEditorCloseGuard>

/** Shared confirmation and save actions for knowledge editors. */
export function KnowledgeEditorFooter(props: {
  close: CloseGuard
  pending: boolean
  loading?: boolean
  disabled?: boolean
  unconfirmed: boolean
  saveKey: DeepSeekHarnessProductKey
  t: (key: DeepSeekHarnessProductKey) => string
  onSave: () => void
}): ReactNode {
  const { close, pending, loading = false, disabled = false, unconfirmed, saveKey, t, onSave } = props
  return close.confirming ? <>
    <Button variant="ghost" size="sm" onClick={close.keepEditing}>{t('knowledgeKeepEditing')}</Button>
    <Button variant="primary" size="sm" onClick={close.discard}>{t('knowledgeDiscardDraft')}</Button>
  </> : <>
    <Button variant="ghost" size="sm" disabled={pending} onClick={close.requestClose}>{t(unconfirmed ? 'knowledgeSuspendSave' : 'cancel')}</Button>
    <Button variant="primary" size="sm" disabled={pending || loading || disabled} onClick={onSave}>{t(pending ? 'saving' : unconfirmed ? 'knowledgeRetrySave' : saveKey)}</Button>
  </>
}
