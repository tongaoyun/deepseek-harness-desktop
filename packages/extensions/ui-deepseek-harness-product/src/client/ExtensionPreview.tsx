/** Read-only import confirmation; staging belongs to the catalog. */
import { useEffect, useRef, useState } from 'react'
import { Button, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExtensionDraftSchema, ExtensionSaveResultSchema, type ExtensionImportPreview } from '@deepseek-harness/product/extension-draft'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { localizedCategory, markdownLabels, nextProductRequestId } from './catalog-shared.tsx'
import { productApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'

/** Preview an imported package without taking ownership of its staging.
 * @param props Read-only content and explicit save or conversation actions.
 * @returns The content confirmation dialog.
 */
export function ExtensionPreview({ preview, onClose, onSaved, onContinue, t }: {
  readonly preview: ExtensionImportPreview
  readonly onClose: () => void
  readonly onSaved: () => void
  readonly onContinue: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}) {
  const [pending, setPending] = useState<'conversation' | 'save'>()
  const [error, setError] = useState<string>()
  const operation = useRef<AbortController | undefined>(undefined)
  const draft = preview.draft
  const checked = ExtensionDraftSchema.safeParse({ ...draft, stageId: preview.stageId })
  useEffect(() => () => { operation.current?.abort() }, [])
  const close = () => { if (!operation.current) onClose() }
  const run = async (action: 'conversation' | 'save', execute: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setPending(action); setError(undefined)
    try { await execute(controller.signal) }
    catch (error) { if (!controller.signal.aborted) setError(productErrorMessage(error, t, action === 'save' ? 'saveFailed' : 'loadFailed')) }
    finally {
      if (operation.current === controller) operation.current = undefined
      if (!controller.signal.aborted) setPending(undefined)
    }
  }
  const save = async (signal: AbortSignal) => {
    const api = productApi()
    if (!api || !checked.success) throw new Error(t('unavailable'))
    const request = nextProductRequestId()
    const cancel = () => { api.cancel(request) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const receipt = ExtensionSaveResultSchema.parse(await api.invoke('extensions.save', checked.data, request))
      if (receipt.kind !== checked.data.kind || receipt.id !== checked.data.id || receipt.version !== checked.data.version
        || receipt.kind === 'skill' && !receipt.installed) throw new Error(t('saveFailed'))
      if (!signal.aborted) onSaved()
    } finally { signal.removeEventListener('abort', cancel) }
  }
  const dependencies = [...new Set(draft.kind === 'expert-kit'
    ? (draft.skills ?? []).flatMap(skill => [...skill.connectorRefs, ...skill.requiredTools, ...skill.knowledgeBaseRefs])
    : [...draft.connectorRefs ?? [], ...draft.requiredTools ?? [], ...draft.knowledgeBaseRefs ?? []])]
  return <Modal open onClose={close} title={t('contentPreview')} closeLabel={t('close')}
    className={css.editorModal as string} contentClassName={css.editorModalContent as string} footer={<>
      <Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={close}>{t('close')}</Button>
      <Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={() => { void run('conversation', onContinue) }}>
        {t(pending === 'conversation' ? 'starting' : 'continueInConversation')}</Button>
      <Button variant="primary" size="sm" disabled={pending !== undefined || !checked.success} onClick={() => { void run('save', save) }}>
        {pending === 'save' ? t('saving') : draft.kind === 'skill' ? t('saveAndInstall') : t('savePersonal')}</Button>
    </>}>
    {error && <p className={css.catalogError} role="alert">{error}</p>}
    <div className={css.editorPreview}>
      <div className={css.importIdentity}><strong>{draft.name || t(draft.kind === 'skill' ? 'createSkill' : 'createExpertKit')}</strong>
        <span>{localizedCategory(draft.category ?? 'other', t)} · {draft.version}</span><p>{draft.summary}</p></div>
      {!checked.success && <p className={css.catalogStatus} role="status">{t('draftIncomplete')}</p>}
      {draft.body && <div className={css.markdown}><MarkdownText text={draft.body} labels={markdownLabels(t)} /></div>}
      {draft.kind === 'expert-kit' && <section className={css.detailSection}><h3>{t('includedSkills')} <span>{draft.skills?.length ?? 0}</span></h3>
        <ul className={css.previewList}>{(draft.skills ?? []).map(skill => <li key={skill.id}>
          <details><summary>{skill.name}</summary><p>{skill.summary}</p>
            <MarkdownText text={skill.body} labels={markdownLabels(t)} /></details></li>)}</ul></section>}
      {!!dependencies.length && <details className={css.editorAdvanced}><summary>{t('dependencyPreview')}</summary>
        <ul className={css.previewList}>{dependencies.map(value => <li key={value}>{value}</li>)}</ul></details>}
      <details className={css.editorAdvanced}><summary>{t('advancedInformation')}</summary>
        <dl className={css.detailMeta}><dt>{t('resourceId')}</dt><dd>{draft.id}</dd></dl>
        <ul className={css.packageFileList}>{preview.files.map(file =>
          <li key={file.path}><code>{file.path}</code><span>{file.bytes} B</span></li>)}</ul>
      </details>
    </div>
  </Modal>
}
