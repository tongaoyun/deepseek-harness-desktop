/** Explicit employee feedback; failed or cancelled submissions retain the draft and operation ID. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconPaperclipOutlineRegular, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi } from './product-api.ts'
import { nextProductRequestId } from './catalog-shared.tsx'
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
  const [reportPending, setReportPending] = useState(false)
  const [deviceState, setDeviceState] = useState<'PENDING' | 'READY' | 'DEGRADED'>('PENDING')
  const operationId = useRef(randomUUID())
  const imageInput = useRef<HTMLInputElement>(null)
  const identityKnown = useRef(false)
  const operation = useRef<{ live: boolean; request?: string; reportRequest?: string; employeeId?: string | undefined }>({ live: true })
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
      if (operation.current.reportRequest) productApi()?.cancel(operation.current.reportRequest)
    }
  }, [])
  useEffect(() => {
    const api = productApi()
    let live = true
    let revision = 0
    const updateIdentity = (employee: unknown) => {
      if (identityKnown.current && employee !== operation.current.employeeId) {
        if (operation.current.request) api?.cancel(operation.current.request)
        if (operation.current.reportRequest) api?.cancel(operation.current.reportRequest)
        delete operation.current.request; delete operation.current.reportRequest
        setPending(false); setReportPending(false)
        setMessage(''); setImages([]); setCategory('BUG'); resetReceipt(); setDeviceState('PENDING')
      }
      identityKnown.current = true
      operation.current.employeeId = typeof employee === 'string' ? employee : undefined
    }
    const unsubscribe = api?.subscribe((event) => {
      if (event.type !== 'session.changed') return
      revision++
      const value = event.payload
      const employee = typeof value === 'object' && value !== null && 'employeeId' in value ? value.employeeId : undefined
      updateIdentity(employee)
    })
    void api?.getSession().then((session) => { if (live && revision === 0) updateIdentity(session.employeeId) }).catch(() => {
      // Session reads can fail during login; subsequent identity events still clear stale drafts.
    })
    return () => { live = false; unsubscribe?.() }
  }, [])
  useEffect(() => {
    if (!open) return
    const api = productApi()
    const request = nextProductRequestId()
    let live = true
    void api?.invoke('support.device.read', {}, request).then((value) => {
      if (live && typeof value === 'object' && value !== null && 'status' in value
        && (value.status === 'READY' || value.status === 'DEGRADED' || value.status === 'PENDING')) setDeviceState(value.status)
    }).catch(() => { if (live) setDeviceState('DEGRADED') })
    return () => { live = false; api?.cancel(request) }
  }, [open])
  const close = () => {
    if (operation.current.request) productApi()?.cancel(operation.current.request)
    if (operation.current.reportRequest) productApi()?.cancel(operation.current.reportRequest)
    if (operation.current.request) setError(t('feedbackSendFailed'))
    delete operation.current.request; delete operation.current.reportRequest
    setPending(false); setReportPending(false)
    onClose()
  }
  const submit = async (): Promise<void> => {
    const api = productApi()
    if (!api || operation.current.request || !message.trim()) return
    const request = nextProductRequestId(); operation.current.request = request
    setPending(true); setError(''); setReceipt('')
    try {
      const attachments = await Promise.all(images.map(async file => ({ name: file.name, mediaType: file.type,
        data: new Uint8Array(await file.arrayBuffer()) })))
      if (!operation.current.live || operation.current.request !== request) return
      const value = await api.invoke('support.feedback.submit', { operationId: operationId.current,
        message, category, images: attachments }, request)
      if (operation.current.request === request && typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') {
        setReceipt(value.id); setMessage(''); setImages([]); operationId.current = randomUUID()
      }
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
  const retryDevice = async (): Promise<void> => {
    const api = productApi()
    if (!api || operation.current.reportRequest) return
    const request = nextProductRequestId(); operation.current.reportRequest = request; setReportPending(true)
    try {
      await api.invoke('support.device.report', {}, request)
      if (operation.current.live && operation.current.reportRequest === request) setDeviceState('READY')
    }
    catch { if (operation.current.live && operation.current.reportRequest === request) setDeviceState('DEGRADED') }
    finally {
      if (operation.current.reportRequest === request) {
        delete operation.current.reportRequest
        if (operation.current.live) setReportPending(false)
      }
    }
  }
  return <Modal open={open} onClose={close} title={t('feedbackTitle')} closeLabel={t('close')} className={css.feedbackModal as string} contentClassName={css.feedbackContent as string}
    footer={<><Button variant="ghost" size="sm" onClick={close}>{t('close')}</Button><Button size="sm" disabled={pending || !message.trim()} onClick={() => { void submit() }}>{t(pending ? 'feedbackSending' : 'feedbackSend')}</Button></>}>
    <div className={css.feedbackBody} onPaste={(event) => {
      const files = Array.from(event.clipboardData.files)
      if (files.length) { event.preventDefault(); addImages(files) }
    }} onDragOver={(event) => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = pending ? 'none' : 'copy' }
    }} onDrop={(event) => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); addImages(Array.from(event.dataTransfer.files)) }
    }}>
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {receipt && <p role="status" className={css.catalogStatus}>{t('feedbackSent')} <span>{receipt}</span></p>}
      <label>{t('feedbackCategory')}<select disabled={pending} value={category} onChange={(event) => { setCategory(event.target.value); resetReceipt() }}>
        <option value="BUG">{t('feedbackBug')}</option><option value="SUGGESTION">{t('feedbackSuggestion')}</option><option value="QUESTION">{t('feedbackQuestion')}</option><option value="OTHER">{t('feedbackOther')}</option>
      </select></label>
      <label>{t('feedbackMessage')}<textarea data-modal-autofocus disabled={pending} maxLength={2000} rows={7} value={message} onChange={(event) => { setMessage(event.target.value); resetReceipt() }} /></label>
      <section className={css.feedbackImages} aria-label={t('feedbackImages')}>
        <div className={css.feedbackImageHeader}><span>{t('feedbackImages')} <small>{images.length}/4</small></span><Button variant="ghost" size="sm" disabled={pending || images.length >= 4} onClick={() => imageInput.current?.click()}><IconPaperclipOutlineRegular size={14} />{t('feedbackAddImages')}</Button></div>
        <input ref={imageInput} hidden aria-label={t('feedbackAddImages')} type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={pending} onChange={(event) => {
          const selected = Array.from(event.target.files ?? []); event.target.value = ''; addImages(selected)
        }} />
        {images.length > 0 && <div className={css.feedbackImageGrid}>{images.map((file, index) => <FeedbackImagePreview key={`${index}-${file.name}`} file={file} pending={pending} t={t} onRemove={() => { setImages(current => current.filter((_, i) => i !== index)); resetReceipt() }} />)}</div>}
        <small className={css.feedbackImageLimit}>{t('feedbackImagesLimit')}</small>
      </section>
      <div className={css.feedbackDevice}><span>{t(deviceState === 'READY' ? 'deviceReportReady' : deviceState === 'DEGRADED' ? 'deviceReportFailed' : 'deviceReportPending')}</span><Button variant="ghost" size="sm" disabled={reportPending} onClick={() => { void retryDevice() }}><IconRefreshOutlineRegular size={14} />{t('deviceReportRetry')}</Button></div>
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
