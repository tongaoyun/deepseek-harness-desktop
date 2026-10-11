import type { ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { type ProductDetail, markdownLabels, withoutFrontmatter } from './catalog-shared.tsx'

export function SkillDetailModal({
  actionError, actionFailure, actionPending, managementActions, detail: product, error, installed, installationsKnown,
  loading, onClose, onUse, open, bundled = false, t,
}: {
  readonly open: boolean
  readonly bundled?: boolean
  readonly detail: ProductDetail | undefined
  readonly loading: boolean
  readonly error: boolean
  readonly actionPending: boolean
  readonly actionError: boolean
  readonly actionFailure?: string | undefined
  readonly managementActions?: ReactNode
  readonly installed: boolean
  readonly installationsKnown: boolean
  readonly onClose: () => void
  readonly onUse: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const guide = product === undefined ? '' : withoutFrontmatter(product.readme)
  const disabled = product === undefined || actionPending || installed || !installationsKnown
    || product.availabilityStatus === 'INCOMPATIBLE'
  return <Modal open={open} onClose={onClose} title={t('skillDetails')} headless className={css.detailModal as string}>
    <div className={css.skillModalHeader}>
      <h2>{t('skillDetails')}</h2>
      <button type="button" className={css.skillModalClose} aria-label={t('close')} title={t('close')} onClick={onClose}>
        <IconCloseOutlineRegular size={14} />
      </button>
    </div>
    <div className={css.skillModalBody} data-skill-detail-body>
      {loading && <p className={css.modalStatus} role="status">{t('loading')}</p>}
      {!loading && error && <p className={css.catalogError} role="alert">{t('detailFailed')}</p>}
      {product !== undefined && <>
        {actionError && <p className={css.catalogError} role="alert">{t('installFailed')}</p>}
        {actionFailure && <p className={css.catalogError} role="alert">{actionFailure}</p>}
        {!product.sourceAvailable ? <p className={css.catalogStatus}>{t('sourceUnavailable')}</p>
          : guide === '' ? <p className={css.catalogStatus}>{t('noGuide')}</p>
            : <div className={css.markdown}><MarkdownText text={guide} labels={markdownLabels(t)} /></div>}
      </>}
    </div>
    {product !== undefined && !bundled && <div className={css.skillModalFooter}>
      <Button variant="primary" size="sm" disabled={disabled}
        onClick={onUse}>{actionPending ? t('installingSkill') : installed ? t('skillInstalled') : t('installSkill')}</Button>
      {managementActions}
    </div>}
  </Modal>
}
