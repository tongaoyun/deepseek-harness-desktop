import { HelpCircle, ImagePlus, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { type FeedbackCategory, type FeedbackSubmit, readFeedbackPaths, validateFeedbackImages } from './feedback'
import { useDialogFocus } from './useDialogFocus'
import { useDesktopDrop } from './useDesktopDrop'

export function FeedbackButton({ onFeedback, onOpen }: { onFeedback: FeedbackSubmit; onOpen?: () => void }) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [category, setCategory] = useState<FeedbackCategory>('BUG')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState('')
  const [images, setImages] = useState<Array<{ file: File; url: string }>>([])
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState('')
  const imagesRef = useRef(images); imagesRef.current = images
  const busy = useRef(false), readBusy = useRef(false), readVersion = useRef(0)
  const dialog = useRef<HTMLFormElement>(null), input = useRef<HTMLInputElement>(null)
  const previewDialog = useRef<HTMLDivElement>(null)
  const close = () => {
    if (busy.current) return
    readVersion.current++; readBusy.current = false; setReading(false); setPreview(''); setOpen(false)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.account')?.focus())
  }
  useDialogFocus(dialog, open ? 'feedback' : '', () => preview ? setPreview('') : close())
  useDialogFocus(previewDialog, preview, () => setPreview(''))
  useEffect(() => () => { readVersion.current++; imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)) }, [])
  const addFiles = (files: File[]) => {
    if (busy.current || state === 'sent' || !files.length) return
    const reason = validateFeedbackImages(files, imagesRef.current.length)
    if (reason) { setError(reason); return }
    const next = [...imagesRef.current, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))]
    imagesRef.current = next; setImages(next); setError('')
  }
  const addPaths = async (paths: string[]) => {
    if (busy.current || readBusy.current || state === 'sent' || !paths.length) return
    const version = ++readVersion.current
    readBusy.current = true; setReading(true)
    try { const files = await readFeedbackPaths(paths); if (version === readVersion.current) addFiles(files) }
    catch (reason) { if (version === readVersion.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (version === readVersion.current) { readBusy.current = false; setReading(false) } }
  }
  const dragging = useDesktopDrop({ enabled: open && state !== 'sent' && isTauri(), scope: 'feedback', running: busy.current, onPaths: addPaths, onError: setError })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!feedback.trim() || busy.current || readBusy.current) return
    busy.current = true; setState('sending'); setError('')
    try {
      await onFeedback(feedback.trim(), category, imagesRef.current.map((image) => image.file))
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)); imagesRef.current = []
      setImages([]); setFeedback(''); setState('sent')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法提交，请稍后重试'); setState('idle') }
    finally { busy.current = false }
  }
  return <>
    <button onClick={() => { setError(''); setState('idle'); setOpen(true); onOpen?.() }} type="button"><HelpCircle size={16} /><span><strong>问题反馈</strong><small>文字描述与截图</small></span></button>
    {open && createPortal(<div className="feedback-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <form aria-labelledby="feedback-title" aria-modal="true" className={`feedback-dialog${dragging ? ' drag-active' : ''}`} data-feedback-drop ref={dialog} role="dialog" onSubmit={submit}
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); addFiles(Array.from(event.dataTransfer.files)) }}
        onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); event.stopPropagation(); addFiles(files) } else if (isTauri() && !event.clipboardData.getData('text/plain')) { event.preventDefault(); const version = readVersion.current; void invoke<string[]>('clipboard_file_paths').then((paths) => { if (version === readVersion.current) return addPaths(paths) }).catch((reason) => { if (version === readVersion.current) setError(String(reason)) }) } }}>
        <button aria-label="关闭反馈" className="feedback-close" disabled={state === 'sending'} onClick={close} type="button"><X size={18} /></button>
        <h2 id="feedback-title">问题反馈</h2><p>描述遇到的问题或建议，可附上截图帮助我们定位。</p>
        {state === 'sent' ? <div className="feedback-success" role="status">反馈已提交，可由管理员在控制中心查看文字和附图。</div> : <>
          <fieldset disabled={state === 'sending'}><label>反馈类型<select value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}><option value="BUG">功能问题</option><option value="SUGGESTION">改进建议</option><option value="QUESTION">使用咨询</option><option value="OTHER">其他</option></select></label>
          <label>问题描述<textarea aria-label="问题描述" maxLength={2000} placeholder="发生了什么？你期望的结果是什么？" value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label><small className="feedback-counter">{feedback.length} / 2000</small>
          <div className="feedback-images">{images.map((image, index) => <div key={image.url}><button aria-label={`预览 ${image.file.name}`} type="button" onClick={() => setPreview(image.url)}><img alt={image.file.name} src={image.url} /></button><button aria-label={`移除图片 ${index + 1}`} type="button" onClick={() => { URL.revokeObjectURL(image.url); const next = imagesRef.current.filter((item) => item !== image); imagesRef.current = next; setImages(next) }}><X size={14} /></button></div>)}
          {images.length < 4 && <button className="feedback-add-image" type="button" disabled={reading} onClick={() => input.current?.click()}><ImagePlus size={22} />添加图片</button>}</div>
          <input aria-label="选择反馈图片" ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <small className="feedback-hint">{reading ? '正在读取图片…' : '支持粘贴或拖入图片，最多 4 张，每张不超过 5 MB。'}</small></fieldset>
          {error && <div className="feedback-error" role="alert">{error}；文字和图片已保留。</div>}
          <p className="feedback-disclosure">仅发送填写的内容、所选图片、版本与任务标识，不自动上传对话或其他文件。</p>
        </>}
        <div className="feedback-actions"><button className="secondary" disabled={state === 'sending'} onClick={close} type="button">{state === 'sent' ? '完成' : '取消'}</button>{state !== 'sent' && <button disabled={!feedback.trim() || state === 'sending' || reading} type="submit">{state === 'sending' ? '正在提交…' : '提交反馈'}</button>}</div>
        {preview && <div className="feedback-preview" ref={previewDialog} role="dialog" aria-modal="true" aria-label="反馈图片预览" onClick={() => setPreview('')}><button aria-label="关闭图片预览" type="button" onClick={() => setPreview('')}><X size={20} /></button><img alt="反馈图片预览" src={preview} /></div>}
      </form>
    </div>, document.body)}
  </>
}
