/** File selection precedes authoring; main owns paths, package validation and staging. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExtensionImportDraftSchema, type ExtensionImportPreview } from '@deepseek-harness/product/extension-draft'
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
  const controller = useRef<{ closed: boolean; request?: string }>({ closed: false })
  useEffect(() => {
    controller.current.closed = false
    return () => {
      controller.current.closed = true
      if (controller.current.request) productApi()?.cancel(controller.current.request)
    }
  }, [])
  const inspect = async (source: 'file' | 'directory'): Promise<void> => {
    const api = productApi()
    if (!api || pending) return
    setPending(true); setError(undefined)
    const request = nextProductRequestId()
    controller.current.request = request
    try {
      const value = await api.invoke('extensions.import.inspect', { kind, source }, request)
      if (typeof value !== 'object' || value === null || !('stageId' in value)) return
      if (typeof value.stageId !== 'string' || !('draft' in value) || !('files' in value) || !Array.isArray(value.files)) throw new Error('Invalid import preview')
      if (controller.current.closed) {
        await api.invoke('extensions.import.release', { stageId: value.stageId }, nextProductRequestId())
        return
      }
      onInspected({ stageId: value.stageId, draft: ExtensionImportDraftSchema.parse(value.draft),
        files: value.files as ExtensionImportPreview['files'],
        missingFields: 'missingFields' in value && Array.isArray(value.missingFields)
          ? value.missingFields.filter((field): field is string => typeof field === 'string') : [] })
    } catch (error) {
      if (!controller.current.closed) setError(productErrorMessage(error, t, 'importFailed'))
    } finally {
      delete controller.current.request
      if (!controller.current.closed) setPending(false)
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
