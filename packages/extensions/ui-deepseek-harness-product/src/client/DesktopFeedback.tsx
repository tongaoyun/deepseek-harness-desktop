/** Explicit employee feedback; failed or cancelled submissions retain the draft and operation ID. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'

/** Enterprise feedback entry; employee and device metadata are supplied only by main. */
export function DesktopFeedback({ open, onClose, t }: {
  readonly open: boolean
  readonly onClose: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [message, setMessage] = useState('')
  const [category, setCategory] = useState('BUG')
  const [images, setImages] = useState<File[]>([])
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  const [pending, setPending] = useState(false)
  const operationId = useRef(randomUUID())
  const messageId = useId()
  const messageInput = useRef<HTMLTextAreaElement>(null)
  const identityKnown = useRef(false)
  const operation = useRef<{ live: boolean; request?: string; employeeId?: string | undefined }>({ live: true })
  const resetReceipt = () => { operationId.current = randomUUID(); setReceipt(''); setError('') }
  const addImages = (selected: File[]) => {
    if (pending || !selected.length) return
    if (images.length + selected.length > 4 || selected.some(file => file.size < 1 || file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      setError(t('feedbackImagesInvalid')); return
    }
    setImages(current => [...current, ...selected]); resetReceipt()
  }
  useEffect(() => {
    operation.current.live = true
    return () => {
      operation.current.live = false
      if (operation.current.request) productApi()?.cancel(operation.current.request)
      delete operation.current.request
    }
  }, [])
  useEffect(() => {
    const api = productApi()
    let live = true
    let revision = 0
    const updateIdentity = (employee: unknown, changed = false) => {
      if (identityKnown.current ? employee !== operation.current.employeeId : changed) {
        if (operation.current.request) api?.cancel(operation.current.request)
        delete operation.current.request
        setPending(false)
        setMessage(''); setImages([]); setCategory('BUG'); resetReceipt()
      }
      identityKnown.current = true
      operation.current.employeeId = typeof employee === 'string' ? employee : undefined
    }
    const unsubscribe = api?.subscribe((event) => {
      if (event.type !== 'session.changed') return
      revision++
      const value = event.payload
      const employee = typeof value === 'object' && value !== null && 'employeeId' in value ? value.employeeId : undefined
      updateIdentity(employee, true)
    })
    void api?.getSession().then((session) => { if (live && revision === 0) updateIdentity(session.employeeId) }).catch(() => {
      // Session reads can fail during login; subsequent identity events still clear stale drafts.
    })
    return () => { live = false; unsubscribe?.() }
  }, [])
  const close = () => {
    if (operation.current.request) productApi()?.cancel(operation.current.request)
    if (operation.current.request) setError(t('feedbackSendFailed'))
    delete operation.current.request
    setPending(false)
    onClose()
  }
  const submit = async (): Promise<void> => {
    const api = productApi()
    if (!api || operation.current.request || !message.trim()) return
    const request = randomUUID(); operation.current.request = request
    setPending(true); setError(''); setReceipt('')
    try {
      const attachments = await Promise.all(images.map(async file => ({ name: file.name, mediaType: file.type,
        data: new Uint8Array(await file.arrayBuffer()) })))
      if (operation.current.request !== request) return
      const value = await api.invoke('support.feedback.submit', { operationId: operationId.current,
        message, category, images: attachments }, request)
      if (!operation.current.live || operation.current.request !== request) return
      if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error('Feedback receipt is missing')
      }
      setReceipt(value.id); setMessage(''); setImages([]); operationId.current = randomUUID()
    } catch (reason) {
      if (operation.current.live && operation.current.request === request) setError(productErrorMessage(reason, t, 'feedbackSendFailed'))
    }
    finally {
      if (operation.current.request === request) {
        delete operation.current.request
        if (operation.current.live) setPending(false)
      }
    }
  }
  return <Modal open={open} onClose={close} title={t('feedbackTitle')} closeLabel={t('close')} className={css.feedbackModal as string} contentClassName={css.feedbackContent as string}
    footer={<><Button variant="ghost" size="sm" onClick={close}>{t('close')}</Button><Button size="sm" disabled={pending || !message.trim()} onClick={() => { void submit() }}>{t(pending ? 'feedbackSending' : 'feedbackSend')}</Button></>}>
    <div className={css.feedbackBody}>
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {receipt && <p role="status" className={css.catalogStatus}>{t('feedbackSent')} <span>{receipt}</span></p>}
      <label>{t('feedbackCategory')}<select disabled={pending} value={category} onChange={(event) => { setCategory(event.target.value); resetReceipt() }}>
        <option value="BUG">{t('feedbackBug')}</option><option value="SUGGESTION">{t('feedbackSuggestion')}</option><option value="QUESTION">{t('feedbackQuestion')}</option><option value="OTHER">{t('feedbackOther')}</option>
      </select></label>
      <div className={css.feedbackField}>
        <label htmlFor={messageId}>{t('feedbackMessage')}</label>
        <div className={css.feedbackEditor} aria-busy={pending} onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (!files.length) return
          event.preventDefault()
          if (pending) return
          const text = event.clipboardData.getData('text/plain')
          const input = messageInput.current
          if (text && input) {
            resetReceipt()
            const start = input.selectionStart, end = input.selectionEnd
            const inserted = text.slice(0, Math.max(0, 2000 - message.length + end - start))
            setMessage(message.slice(0, start) + inserted + message.slice(end))
          }
          addImages(files)
        }} onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = pending ? 'none' : 'copy' }
        }} onDrop={(event) => {
          if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); addImages(Array.from(event.dataTransfer.files)) }
        }}>
          <textarea ref={messageInput} id={messageId} data-modal-autofocus disabled={pending} maxLength={2000} rows={7}
            value={message} onChange={(event) => { setMessage(event.target.value); resetReceipt() }} />
          {images.length > 0 && <div className={css.feedbackImageGrid} aria-label={t('feedbackImages')}>{images.map((file, index) => <FeedbackImagePreview key={`${index}-${file.name}`} file={file} pending={pending} t={t} onRemove={() => { setImages(current => current.filter((_, i) => i !== index)); resetReceipt() }} />)}</div>}
          <div className={css.feedbackEditorMeta}>
            <span>{message.length}/2000</span>{images.length > 0 && <span>{images.length}/4</span>}
          </div>
        </div>
      </div>
    </div>
  </Modal>
}

function FeedbackImagePreview({ file, pending, t, onRemove }: {
  file: File
  pending: boolean
  t: (key: DeepSeekHarnessProductKey) => string
  onRemove: () => void
}): ReactNode {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const preview = URL.createObjectURL(file)
    setUrl(preview); setFailed(false)
    return () => { URL.revokeObjectURL(preview) }
  }, [file])
  return <div className={css.feedbackImageItem}>
    <div className={css.feedbackImageFrame}>{failed ? <span>{t('feedbackImagePreviewFailed')}</span> : url && <img src={url} alt={file.name} onError={() => { setFailed(true) }} />}
      <button type="button" disabled={pending} title={t('remove')} aria-label={`${t('remove')} ${file.name}`} onClick={onRemove}><IconCloseOutlineRegular size={14} /></button>
    </div><small title={file.name}>{file.name}</small>
  </div>
}
