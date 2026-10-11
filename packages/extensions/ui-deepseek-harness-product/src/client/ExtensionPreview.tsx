/** Read-only extension preview; content changes belong to the creation conversation. */
import { useEffect, useRef, useState } from 'react'
import { Button, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExtensionDraftSchema, type ExtensionImportPreview, type ExtensionAuthoringSnapshot } from '@deepseek-harness/product/extension-draft'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { localizedCategory, markdownLabels, nextProductRequestId } from './catalog-shared.tsx'
import { productApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'

/** Preview an imported package or the current conversation revision.
 * @param props Read-only content and explicit save or conversation actions.
 * @returns The content confirmation dialog.
 */
export function ExtensionPreview({ preview, onClose, onSaved, onContinue, t }: {
  readonly preview: ExtensionImportPreview | ExtensionAuthoringSnapshot
  readonly onClose: () => void
  readonly onSaved: () => void
  readonly onContinue: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}) {
  const [pending, setPending] = useState<'conversation' | 'save'>()
  const [error, setError] = useState<string>()
  const requests = useRef(new Set<string>())
  const active = useRef(true)
  const imported = 'stageId' in preview
  const draft = preview.draft
  const checked = ExtensionDraftSchema.safeParse(draft)
  const saved = 'saved' in preview && preview.saved !== undefined
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      const api = productApi()
      for (const request of requests.current) api?.cancel(request)
      if ('stageId' in preview) void api?.invoke('extensions.import.release', { stageId: preview.stageId }, nextProductRequestId()).catch(() => undefined)
    }
  }, [])
  const run = async (action: 'conversation' | 'save', operation: () => Promise<void>) => {
    setPending(action); setError(undefined)
    try { await operation() }
    catch (error) { if (active.current) setError(productErrorMessage(error, t, action === 'save' ? 'saveFailed' : 'loadFailed')) }
    finally { if (active.current) setPending(undefined) }
  }
  const save = async () => {
    const api = productApi()
    if (!api || !checked.success) throw new Error(t('unavailable'))
    const request = nextProductRequestId(); requests.current.add(request)
    try {
      await api.invoke(imported ? 'extensions.save' : 'extensions.authoring.save', imported ? checked.data
        : { sessionId: preview.sessionId, authoringId: preview.authoringId, revision: preview.revision }, request)
      if (active.current) onSaved()
    } finally { requests.current.delete(request) }
  }
  const dependencies = [...new Set(draft.kind === 'expert-kit'
    ? (draft.skills ?? []).flatMap(skill => [...skill.connectorRefs, ...skill.requiredTools, ...skill.knowledgeBaseRefs])
    : [...draft.connectorRefs ?? [], ...draft.requiredTools ?? [], ...draft.knowledgeBaseRefs ?? []])]
  return <Modal open onClose={onClose} title={t('contentPreview')} closeLabel={t('close')}
    className={css.editorModal as string} contentClassName={css.editorModalContent as string} footer={<>
      <Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={onClose}>{t('close')}</Button>
      {!saved && <Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={() => { void run('conversation', onContinue) }}>
        {t(pending === 'conversation' ? 'starting' : 'continueInConversation')}</Button>}
      <Button variant="primary" size="sm" disabled={pending !== undefined || !checked.success || saved} onClick={() => { void run('save', save) }}>
        {pending === 'save' ? t('saving') : saved ? t('extensionSaved') : draft.kind === 'skill' ? t('saveAndInstall') : t('savePersonal')}</Button>
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
      {!!draft.commonTasks?.length && <section className={css.detailSection}><h3>{t('commonTasks')}</h3>
        <ul className={css.previewList}>{draft.commonTasks.map(task =>
          <li key={task.id}><strong>{task.name}</strong><p>{task.prompt}</p></li>)}</ul></section>}
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
