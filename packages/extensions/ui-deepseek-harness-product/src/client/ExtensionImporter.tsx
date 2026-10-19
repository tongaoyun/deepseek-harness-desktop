/** File selection precedes authoring; main owns paths, package validation and staging. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExtensionImportPreviewSchema, type ExtensionImportPreview } from '@deepseek-harness/product/extension-draft'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi } from './product-api.ts'
import { nextProductRequestId } from './catalog-shared.tsx'
import { productErrorMessage } from './product-errors.ts'

/** Select a standard package and hand its validated preview to the editor. */
export function ExtensionImporter({ kind, onClose, onInspected, t }: {
  readonly kind: 'skill' | 'expert-kit'
  readonly onClose: () => void
  readonly onInspected: (preview: ExtensionImportPreview) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const lifecycle = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    return () => { controller.abort() }
  }, [])
  const inspect = async (source: 'file' | 'directory'): Promise<void> => {
    const api = productApi()
    if (!api || pending) return
    setPending(true); setError(undefined)
    const request = nextProductRequestId()
    const signal = lifecycle.current.signal
    const cancel = () => { api.cancel(request) }
    signal.addEventListener('abort', cancel, { once: true })
    let stageId: string | undefined
    let transferred = false
    try {
      const value = await api.invoke('extensions.import.inspect', { kind, source }, request)
      if (typeof value === 'object' && value !== null) {
        if ('cancelled' in value && value.cancelled === true) return
        if ('stageId' in value && typeof value.stageId === 'string') stageId = value.stageId
      }
      if (signal.aborted) return
      const preview = ExtensionImportPreviewSchema.parse(value)
      if (preview.draft.kind !== undefined && preview.draft.kind !== kind) throw new Error('Unexpected import kind')
      onInspected(preview)
      transferred = true
    } catch (error) {
      if (!signal.aborted) setError(productErrorMessage(error, t, 'importFailed'))
    } finally {
      signal.removeEventListener('abort', cancel)
      if (stageId !== undefined && !transferred) {
        try { await api.invoke('extensions.import.release', { stageId }, nextProductRequestId()) }
        catch (error) { if (!signal.aborted) setError(productErrorMessage(error, t, 'importFailed')) }
      }
      if (!signal.aborted) setPending(false)
    }
  }
  return <Modal open onClose={onClose} title={t(kind === 'skill' ? 'importSkill' : 'importExpertKit')} closeLabel={t('close')}
    className={css.importModal as string} footer={<Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>}>
    <div className={css.importBody}>
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      <button type="button" className={css.importTarget} aria-label={t('choosePackageFile')} disabled={pending} data-modal-autofocus
        onClick={() => { void inspect('file') }}>
        <IconDownloadOutlineRegular size={28} />
        <strong>{t('choosePackageFile')}</strong>
        <span>{t(kind === 'skill' ? 'skillImportFormat' : 'kitImportFormat')}</span>
      </button>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => { void inspect('directory') }}>
        <IconFolderOpenOutlineRegular size={16} />{t('choosePackageDirectory')}</Button>
      {pending && <p role="status" className={css.catalogStatus}>{t('inspectingPackage')}</p>}
      <div className={css.importRequirements}>
        <strong>{t('packageRequirements')}</strong>
        <p>{t(kind === 'skill' ? 'skillPackageRequirement' : 'kitPackageRequirement')}</p>
      </div>
    </div>
  </Modal>
}
