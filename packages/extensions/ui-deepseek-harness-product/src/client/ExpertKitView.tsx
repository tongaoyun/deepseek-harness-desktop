import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button, IconAgentPresetOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconBrowseOutlineRegular, IconDeliverDocRegular, IconDownloadOutlineRegular, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { type ProductDetail, type CommonTask, type ProductReference, unavailableForUse, markdownLabels, DetailIdentity, ReferenceList, withoutFrontmatter, withoutDuplicateTitle } from './catalog-shared.tsx'

export function ExpertKitDetailPage({
  actionError, actionPending, installed, installationsKnown, managementActions, detail: product, onBack, onUse, onInstall, onOpen, t,
}: {
  readonly detail: ProductDetail
  readonly onBack: () => void
  readonly onUse: (task?: CommonTask) => void
  readonly actionPending: boolean
  readonly installed: boolean
  readonly installationsKnown: boolean
  readonly onInstall: () => void
  readonly actionError: string | undefined
  readonly managementActions?: ReactNode
  readonly onOpen?: (value: ProductReference) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const disabled = actionPending || !installationsKnown || !installed || unavailableForUse(product.availabilityStatus)
  const guide = withoutFrontmatter(product.readme, product.name)
  const preview = withoutDuplicateTitle(guide, t('kitGuide'))
  const [guideOpen, setGuideOpen] = useState(false)
  return <article className={css.expertDetailPage}>
    <button className={css.backButton} type="button" onClick={onBack}>
      <IconChevronLeftOutlineRegular size={16} />{t('backToCatalog')}
    </button>
    <div className={css.expertHero}>
      <DetailIdentity detail={product} icon={IconAgentPresetOutlineRegular} t={t} />
      <div className={css.detailActions}>
        {installed ? <span className={css.cardInstalled}>{t('expertKitInstalled')}</span>
          : <Button variant="outline" size="sm" disabled={actionPending || !installationsKnown || product.availabilityStatus === 'INCOMPATIBLE'}
            onClick={onInstall}><IconDownloadOutlineRegular size={14} />{t('installExpertKit')}</Button>}
        {installed && installationsKnown && <Button variant="primary" size="sm" disabled={disabled} onClick={() => { onUse() }}>
          {actionPending ? t('starting')
            : product.availabilityStatus === 'PREPARATION_FAILED' ? t('retry') : t('startUsing')}
        </Button>}{managementActions}</div>
    </div>
    {actionError && <p className={css.catalogError} role="alert">{actionError}</p>}
    {product.summary !== undefined && <p className={css.detailSummary}>{product.summary}</p>}
    <section className={css.detailSection}>
      <h2>{t('commonTasks')} <span>{product.commonTasks.length}</span></h2>
      {product.commonTasks.length === 0 ? <p className={css.catalogStatus}>{t('empty')}</p>
        : <div className={css.commandList}>{product.commonTasks.map(task => <button className={css.commandRow}
          disabled={disabled} key={task.id} type="button" onClick={() => { onUse(task) }}>
          <span className={css.commandCopy}><strong>{task.name}</strong><span>{task.description}</span></span>
          <IconChevronRightOutlineRegular size={16} />
        </button>)}</div>}
    </section>
    <section className={css.detailSection}>
      <h2>{t('includedSkills')} <span>{product.skillDetails.length}</span></h2>
      <ReferenceList values={product.skillDetails.map(skill => ({ id: skill.id, name: skill.name,
        ...(skill.summary === undefined ? {} : { description: skill.summary }), available: true, kind: 'skills' }))}
      showStatus={false} {...onOpen ? { onOpen } : {}} t={t} />
    </section>
    <section className={css.detailSection}>
      <h2>{t('dataConnections')} <span>{product.connectorDetails.length}</span></h2>
      <ReferenceList values={product.connectorDetails} {...onOpen ? { onOpen } : {}} t={t} />
    </section>
    <section className={css.detailSection}>
      <h2>{t('knowledgeScope')} <span>{product.knowledgeBaseDetails.length}</span></h2>
      <ReferenceList values={product.knowledgeBaseDetails} {...onOpen ? { onOpen } : {}} t={t} />
    </section>
    <section className={`${css.detailSection} ${css.guideFrame}`}>
      <h2><IconDeliverDocRegular size={16} />{t('kitGuide')}</h2>
      {!product.sourceAvailable ? <p className={css.catalogStatus}>{t('sourceUnavailable')}</p>
        : guide === '' ? <p className={css.catalogStatus}>{t('noGuide')}</p>
          : <>
            <div className={`${css.markdown} ${css.guidePreview}`} ref={(element) => { if (element) element.inert = true }}>
              <h3>{product.name}</h3><MarkdownText text={preview} labels={markdownLabels(t)} />
            </div>
            <button className={css.guideTrigger} type="button" aria-label={t('viewFullGuide')} title={t('viewFullGuide')}
              onClick={() => { setGuideOpen(true) }}><IconBrowseOutlineRegular size={16} /></button>
          </>}
    </section>
    <Modal open={guideOpen} onClose={() => { setGuideOpen(false) }} title={t('kitGuide')} closeLabel={t('close')}
      className={`${css.guideModal}`} contentClassName={`${css.guideModalContent}`}>
      <div className={css.markdown}><h1 className={css.guideTitle}>{product.name}</h1>
        <MarkdownText text={guide} labels={markdownLabels(t)} />
      </div>
    </Modal>
  </article>
}
