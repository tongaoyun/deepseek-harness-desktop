import { PackageTransferError, importPackageFiles, draftPackageFiles, downloadPackage, addPackageResources, base64ByteLength } from './package-files.ts'
import { LibraryConfirm, LibraryEditorFooter } from './library-ui.tsx'
import { Button, Input, Modal } from './plugin-ui.ts'
import React from 'react'
import { CategorySelect } from './category-select.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { customExpertInputSchema, isExpertConflict, DEFAULT_EXPERT_EMOJI, type CatalogSnapshot, type CustomExpertInput } from '../expert-contract.ts'
import type { AgencyCatalogRemote } from './remote.ts'
import { EXPERT_AVATAR_URLS } from './avatars.ts'
import { EN_DIVISION, ZH_DIVISION } from '../names.ts'

import { loadEditorReview, continueEditorReview, type EditorReview } from "./editor-review.ts";

const h = React.createElement
export interface CustomEditorProps {
  readonly expert?: CustomExpertInput
  readonly importOnly?: boolean
  readonly enabled: boolean
  readonly revision: number
  readonly divisions: readonly string[]
  readonly remote: AgencyCatalogRemote
  readonly signal?: AbortSignal
  readonly t: TranslateNS<'agency'>
  readonly locale: 'zh' | 'en'
  /** Capture the owner's current directory before dispatch.
   * @returns Success consumer for this one write.
   */
  readonly prepareSave: () => (catalog: CatalogSnapshot) => void
  readonly onClose: () => void
}

/** 原生模态窗口承载表单，未保存修改由独立确认层保护。 */
export function CustomExpertEditor(props: CustomEditorProps): React.ReactElement {
  const lifecycle = React.useRef(new AbortController())
  React.useEffect(() => {
    if (lifecycle.current.signal.aborted) lifecycle.current = new AbortController()
    const owner = lifecycle.current
    return () => owner.abort()
  }, [])
  const readSignal = () => props.signal ? AbortSignal.any([props.signal, lifecycle.current.signal]) : lifecycle.current.signal
  const [initial, setInitial] = React.useState(() => ({
    ...props.expert,
    name: props.expert?.name ?? '', description: props.expert?.description ?? '',
    division: props.expert?.division ?? 'specialized', prompt: props.expert?.prompt ?? '', resources: props.expert?.resources ?? {},
    emoji: props.expert?.emoji || DEFAULT_EXPERT_EMOJI, avatar: props.expert?.avatar ?? 0,
  }))
  const [draft, setDraft] = React.useState(initial)
  const [revision, setRevision] = React.useState(props.revision);
  const [enabled, setEnabled] = React.useState(props.enabled);
  const [needsReview, setNeedsReview] = React.useState(false);
  const [review, setReview] = React.useState<EditorReview | null>(null);
  const [busy, setBusy] = React.useState(false)
  const saving = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const [discard, setDiscard] = React.useState(false)
  const form = React.useRef<HTMLFormElement | null>(null)
  const zipInput = React.useRef<HTMLInputElement | null>(null)
  const directoryInput = React.useRef<HTMLInputElement | null>(null)
  const attachmentInput = React.useRef<HTMLInputElement | null>(null)
  const [avatarExpanded, setAvatarExpanded] = React.useState(false)
  const selectFiles = (action: (files: readonly File[]) => void) => (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (files.length) action(files)
  }
  const close = (): void => {
    if (saving.current) return
    if (JSON.stringify(draft) !== JSON.stringify(initial)) setDiscard(true)
    else props.onClose()
  }
  const set = (key: 'name' | 'description' | 'division' | 'prompt' | 'agents', value: string): void => {
    setDraft(current => ({ ...current, [key]: value }))
    setError(null)
  }
  const refreshReview = (): void => {
    const signal = readSignal()
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setReview(null);
    void loadEditorReview(props.remote, draft.slug, props.locale, signal)
      .then((value) => { signal?.throwIfAborted(); setReview(value) })
      .catch((cause: unknown) => { if (!signal?.aborted) setError(cause instanceof PackageTransferError ? props.t(cause.key) : cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { saving.current = false; if (!signal?.aborted) setBusy(false); });
  };
  const continueReview = (useLatest: boolean): void => {
    if (review === null) return;
    const next = continueEditorReview(review, draft, useLatest);
    setDraft({ ...next.expert, resources: next.expert.resources ?? {}, emoji: next.expert.emoji ?? DEFAULT_EXPERT_EMOJI, avatar: next.expert.avatar ?? 0 });
    if (review.expert !== undefined) setInitial(customExpertInputSchema.parse(review.expert));
    setRevision(next.revision);
    setEnabled(next.enabled);
    setReview(null);
    setNeedsReview(false);
    setError(null);
  };
  const importFiles = (selection: readonly File[]): void => {
    const signal = readSignal()
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    void importPackageFiles(selection, signal).then(async files => {
      signal?.throwIfAborted()
      const result = await props.remote.importExpert(files, signal)
      signal?.throwIfAborted()
      if (!result.ok) throw result.error
      let manifest = result.value.manifest
      if (draft.slug && manifest) {
        const document: Record<string, unknown> = JSON.parse(manifest)
        const worker = typeof document.worker === 'object' && document.worker !== null ? document.worker : {}
        if (!('suggested_name' in worker) || worker.suggested_name !== draft.slug) manifest = JSON.stringify({ ...document, worker: { ...worker, suggested_name: draft.slug } })
      }
      setDraft({ ...result.value, manifest, slug: draft.slug, resources: result.value.resources ?? {}, emoji: result.value.emoji ?? DEFAULT_EXPERT_EMOJI, avatar: result.value.avatar ?? 0 })
    }).catch((cause: unknown) => { if (!signal?.aborted) setError(cause instanceof PackageTransferError ? props.t(cause.key) : cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { saving.current = false; if (!signal.aborted) setBusy(false) })
  }
  const attachments = async (selection: readonly File[]): Promise<void> => {
    if (saving.current) return
    const signal = readSignal()
    saving.current = true; setBusy(true); setError(null)
    try {
      const resources = await addPackageResources(draft, selection, signal)
      signal.throwIfAborted()
      setDraft(current => ({ ...current, resources }))
    } catch (cause) { if (!signal.aborted) setError(cause instanceof PackageTransferError ? props.t(cause.key) : cause instanceof Error ? cause.message : String(cause)) }
    finally { saving.current = false; if (!signal.aborted) setBusy(false) }
  }
  const submit = (enabled: boolean): void => {
    const signal = readSignal()
    if (saving.current || needsReview || form.current?.reportValidity() !== true) return
    const parsed = customExpertInputSchema.safeParse(draft)
    if (!parsed.success) { setError(props.t('custom.invalid')); return }
    // 名称以 Host 当前名册为准；旧本地名册不能拦截已被其他窗口释放的名称。
    saving.current = true
    setBusy(true)
    setError(null)
    signal?.throwIfAborted()
    const saved = props.prepareSave()
    void props.remote.saveCustomExpert(parsed.data, enabled, revision, signal).then(result => {
      signal?.throwIfAborted()
      if (!result.ok) throw result.error
      saved(result.value)
    }).catch((cause: unknown) => {
      if (signal?.aborted) return
      const message = cause instanceof PackageTransferError ? props.t(cause.key) : cause instanceof Error ? cause.message : String(cause)
      const conflict = isExpertConflict(cause);
      setNeedsReview(conflict);
      if (conflict) setReview(null);
      setError(conflict ? props.t("custom.conflict") : message);
    }).finally(() => { saving.current = false; if (!signal?.aborted) setBusy(false) })
  }
  const label = (text: string, control: React.ReactNode, required = false): React.ReactElement => h('label', { className: 'aag-custom-field' },
    h('span', null, text, required ? h('small', null, props.t('custom.required')) : null), control)
  const input = (key: 'name' | 'description', text: string, maxLength: number): React.ReactElement => h(Input, {
    value: draft[key], maxLength, required: true, disabled: busy,
    'aria-label': text, onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(key, event.currentTarget.value),
    ...(key === 'name' ? { placeholder: props.t('custom.namePlaceholder') } : {}),
  })
  const waitingForImport = props.importOnly === true && draft.prompt.trim() === ''
  return h(Modal, {
    open: true,
    className: 'aag-editor-modal',
    contentClassName: 'aag-editor-modal-content',
    title: props.t(props.importOnly ? 'custom.importPackage' : draft.slug ? 'custom.edit' : 'custom.new'),
    closeLabel: props.t('settings.promptClose'),
    onClose: () => { if (discard) setDiscard(false); else close() },
    footer: waitingForImport ? h(Button, { onClick: close, disabled: busy }, props.t('custom.cancel')) : h(LibraryEditorFooter, {
      editing: !!draft.slug, busy, blocked: needsReview, inert: discard,
      help: props.t('custom.enableHint'), cancelLabel: props.t('custom.cancel'), saveLabel: props.t('custom.save'),
      primaryLabel: props.t(busy ? 'custom.saving' : draft.slug ? 'custom.saveChanges' : 'custom.saveEnable'),
      close, save: () => submit(false), primary: () => submit(draft.slug ? enabled : true),
    }),
  },
  h('form', { ref: form, className: 'aag-custom-body', onSubmit: (event: React.FormEvent) => event.preventDefault(), inert: discard ? '' : undefined },
    h('p', { className: 'aag-editor-intro' }, props.t(waitingForImport ? 'custom.importHint' : 'custom.intro')),
    h('div', { className: 'aag-package-toolbar', role: 'group', 'aria-label': props.t('custom.packageActions') },
      h('input', { ref: zipInput, type: 'file', accept: '.zip', hidden: true, disabled: busy, 'aria-label': props.t('custom.importZip'), onChange: selectFiles(importFiles) }),
      h('input', { ref: directoryInput, type: 'file', multiple: true, webkitdirectory: '', hidden: true, disabled: busy, 'aria-label': props.t('custom.importDirectory'), onChange: selectFiles(importFiles) }),
      h(Button, { disabled: busy, onClick: () => zipInput.current?.click() }, props.t('custom.importZip')),
      h(Button, { disabled: busy, onClick: () => directoryInput.current?.click() }, props.t('custom.importDirectory')),
      h(Button, { className: 'aag-package-export', disabled: busy || !draft.prompt.trim(), onClick: () => { try { downloadPackage(draftPackageFiles(draft)) } catch (cause) { setError(cause instanceof PackageTransferError ? props.t(cause.key) : cause instanceof Error ? cause.message : String(cause)) } } }, props.t('custom.exportZip'))),
    waitingForImport ? null : h(React.Fragment, null,
    h('div', { className: 'aag-custom-identity' },
      h('img', { src: EXPERT_AVATAR_URLS[draft.avatar], width: 44, height: 44, alt: '' }),
      h(Button, { disabled: busy, 'aria-expanded': avatarExpanded, 'aria-controls': 'aag-custom-avatars', onClick: () => setAvatarExpanded(value => !value) }, props.t('custom.changeAvatar'))),
    avatarExpanded ? h('fieldset', { id: 'aag-custom-avatars', className: 'aag-custom-avatars', disabled: busy }, h('legend', null, props.t('custom.avatar')),
      EXPERT_AVATAR_URLS.map((url, index) => h('button', {
        key: url, type: 'button', 'aria-label': `${props.t('custom.avatar')} ${index + 1}`,
        'aria-pressed': draft.avatar === index, className: draft.avatar === index ? 'is-selected' : '',
        onClick: () => { setDraft(current => ({ ...current, avatar: index })); setAvatarExpanded(false) },
      }, h('img', { src: url, width: 36, height: 36, alt: '', loading: 'lazy' })))) : null,
    label(props.t('custom.name'), input('name', props.t('custom.name'), 40), true),
    label(props.t('custom.description'), h(Input.TextArea, {
      value: draft.description, rows: 2, maxLength: 160, required: true, disabled: busy,
      'aria-label': props.t('custom.description'), placeholder: props.t('custom.descriptionPlaceholder'),
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => set('description', event.currentTarget.value),
    }), true),
    h('div', { className: 'aag-custom-field' },
      h('label', { htmlFor: 'aag-custom-division' }, props.t('custom.division')),
      h(CategorySelect, {
        id: 'aag-custom-division', value: draft.division, disabled: busy, label: props.t('custom.division'),
        onChange: (value: string) => set('division', value),
        options: props.divisions.map(division => ({ value: division, label: (props.locale === 'en' ? EN_DIVISION : ZH_DIVISION)[division] ?? division })),
      })),
    h('div', { className: 'aag-custom-prompt-head' }, h('label', { htmlFor: 'aag-custom-prompt' }, props.t('custom.prompt')),
      draft.prompt === '' ? h(Button, { disabled: busy, onClick: () => set('prompt', props.t('custom.templateText')) }, props.t('custom.template')) : null),
    h(Input.TextArea, {
      id: 'aag-custom-prompt', className: 'aag-custom-prompt', value: draft.prompt, rows: 8, required: true, maxLength: 128 * 1024, disabled: busy,
      'aria-label': props.t('custom.prompt'), placeholder: props.t('custom.promptPlaceholder'),
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => set('prompt', event.currentTarget.value),
    }),
    label(props.t('custom.agents'), h(Input.TextArea, { value: draft.agents ?? '', rows: 5, maxLength: 128 * 1024, disabled: busy, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => set('agents', event.currentTarget.value) })),
    h('section', { className: 'aag-custom-resources', 'aria-label': props.t('custom.resources') },
      h('div', { className: 'aag-custom-resource-head' },
        h('h3', null, props.t('custom.resources')),
        h('input', { ref: attachmentInput, type: 'file', multiple: true, hidden: true, disabled: busy, 'aria-label': props.t('custom.attachments'), onChange: selectFiles(files => { void attachments(files) }) }),
        h(Button, { disabled: busy, onClick: () => attachmentInput.current?.click() }, props.t('custom.attachments'))),
      Object.keys(draft.resources).length === 0
        ? h('p', { className: 'aag-custom-resource-empty' }, props.t('custom.resourcesHint'))
        : h('ul', { className: 'aag-custom-resource-list' }, Object.entries(draft.resources).sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => h('li', { key: path },
          h('span', { className: 'aag-custom-resource-path', title: path }, path),
          h('span', { className: 'aag-custom-resource-size' }, new Intl.NumberFormat(props.locale, { style: 'unit', unit: base64ByteLength(value) < 1024 ? 'byte' : 'kilobyte', maximumFractionDigits: 1 }).format(base64ByteLength(value) / (base64ByteLength(value) < 1024 ? 1 : 1024))),
          h(Button, { disabled: busy, 'aria-label': `${props.t('custom.removeAttachment')}: ${path}`, onClick: () => { setError(null); setDraft(current => ({ ...current, resources: Object.fromEntries(Object.entries(current.resources).filter(([name]) => name !== path)) })) } }, props.t('custom.removeAttachment')))))),
    ),
    error === null ? null : h('div', { className: 'aag-error', role: 'alert' }, error),
      needsReview ? h("section", { className: "aag-custom-review" },
        h(Button, { disabled: busy, onClick: refreshReview }, props.t("custom.reviewLatest")),
        review === null ? null : h(React.Fragment, null,
          h("h4", null, props.t("custom.latestContent")),
          review.expert === undefined
            ? h("p", null, props.t(draft.slug ? "custom.reviewDeleted" : "custom.reviewNew"))
            : h(React.Fragment, null,
                h("p", null, review.expert.name),
                h("p", null, review.expert.description),
                h("p", null, props.locale === "zh" ? ZH_DIVISION[review.expert.division] ?? review.expert.division : EN_DIVISION[review.expert.division] ?? review.expert.division),
                h("img", { src: EXPERT_AVATAR_URLS[review.expert.avatar ?? 0], width: 36, height: 36, alt: props.t("custom.avatar") }),
                h(Input.TextArea, { readOnly: true, value: review.expert.prompt, "aria-label": props.t("custom.latestContent"), rows: 8 }),
              ),
          h("p", null, props.t("custom.reviewHint")),
          h("div", { className: "aag-custom-review-actions" },
            h(Button, { disabled: busy, onClick: () => continueReview(false) }, props.t(draft.slug && review.expert === undefined ? "custom.continueAsNew" : "custom.keepDraft")),
            review.expert === undefined ? null : h(Button, { disabled: busy, onClick: () => continueReview(true) }, props.t("custom.useLatest")),
          ),
        ),
      ) : null,
  ),
  discard ? h(LibraryConfirm, { title: props.t('custom.discardTitle'), description: props.t('custom.discardDesc'), cancelLabel: props.t('custom.keep'), confirmLabel: props.t('custom.discard'), danger: true, close: () => setDiscard(false), confirm: props.onClose }) : null)
}

export function CustomDeleteDialog(props: { name: string; busy: boolean; error: string | null; t: TranslateNS<'agency'>; close(): void; confirm(): void }): React.ReactElement {
  return h(LibraryConfirm, { title: props.t('custom.deleteTitle'), description: props.t('custom.deleteHint'), busy: props.busy, error: props.error, cancelLabel: props.t('custom.cancel'), confirmLabel: props.t('custom.delete'), danger: true, close: props.close, confirm: props.confirm },
    h('p', null, props.name))
}
export const CUSTOM_EDITOR_CSS = `
/* 宿主 Modal 的 content 由 contentClassName 标记；body 无公开类名，用「content 内最后一个 div」锁定内容槽。 */
.aag-editor-modal-content{flex:1;min-height:0;overflow:hidden}
.aag-editor-modal-content>div:last-child{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;margin-top:0;padding:0}
.aag-custom-body{overflow-y:auto;overscroll-behavior:contain;padding:16px 20px;flex:1;min-height:0}
.aag-editor-intro{margin:0 0 16px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.aag-custom-field{display:block;margin:18px 0;font-size:14px}
.aag-custom-field>span,.aag-custom-field>label{display:block;margin-bottom:8px}
.aag-custom-field small{font-size:11px;opacity:.65;margin-left:8px}
.aag-package-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.aag-package-export{margin-left:auto}
.aag-custom-identity{display:flex;align-items:center;gap:12px;margin:20px 0}
.aag-custom-identity>img{border-radius:var(--dsw-radius-sm,8px);object-fit:cover}
.aag-custom-resources{margin-top:24px;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2)}
.aag-custom-resource-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.aag-custom-resource-head h3{margin:0;font-size:14px;font-weight:600}
.aag-custom-resource-empty{margin:10px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.aag-custom-resource-list{list-style:none;padding:0;margin:12px 0 0}
.aag-custom-resource-list li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.aag-custom-resource-path{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px}
.aag-custom-resource-size{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.aag-custom-avatars{border:0;padding:0;margin:20px 0;display:flex;gap:8px;flex-wrap:wrap}
.aag-custom-avatars legend{margin-bottom:10px;font-size:13px}
.aag-custom-avatars button{padding:3px;border:2px solid transparent;background:transparent;border-radius:var(--dsw-radius-md,12px);cursor:pointer}
.aag-custom-avatars img{border-radius:var(--dsw-radius-sm,8px);object-fit:cover}
.aag-custom-avatars button.is-selected{border-color:var(--dsw-alias-brand-primary)}
.aag-custom-avatars button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.aag-custom-prompt-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:8px;font-size:14px}
.aag-editor-modal .aag-custom-prompt{min-height:220px;line-height:1.8}
.aag-custom-body .aag-error{margin-top:14px}
.aag-custom-footer{padding:14px 20px 18px;border-top:0.5px solid var(--dsw-alias-border-l2);flex-shrink:0}
/* footer 进入宿主 footer 槽后，水平内边距由宿主提供，避免 24px+20px 叠加。 */
.aag-editor-modal .aag-custom-footer{box-sizing:border-box;width:100%;padding:14px 0 0}
.aag-custom-footer>div{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}
.aag-custom-footer>div>button:first-child{margin-right:auto}
.aag-custom-badge{display:inline-block;font-size:10px;padding:1px 5px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs,4px);margin-left:6px;color:var(--dsw-alias-label-secondary)}
.aag-custom-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.aag-custom-review{margin-top:16px;padding:14px;border:0.5px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm,8px)}
.aag-custom-review-actions{display:flex;flex-wrap:wrap;gap:8px}
.aag-custom-review p{overflow-wrap:anywhere}
@media(max-width:560px){.aag-package-export{margin-left:0}.aag-custom-resource-size{display:none}.aag-custom-body{padding:14px}.aag-custom-footer{padding:12px 14px 16px}.aag-custom-prompt-head{flex-wrap:wrap}}
`
