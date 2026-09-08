import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './useDialogFocus'

export function TaskImagePreview({ name, load, dimensions }: { name: string; load: () => Promise<string>; dimensions?: string }) {
  const card = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const [selected, setSelected] = useState(false)
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useDialogFocus(dialog, selected && source && !error ? name : '', () => setSelected(false))

  useEffect(() => {
    if (!card.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(card.current)
    return () => observer.disconnect()
  }, [])

  const active = visible || selected
  useEffect(() => {
    setSource(''); setError('')
    if (!active) return
    let disposed = false
    let url = ''
    void load().then((data) => {
      if (disposed) return
      const match = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,/.exec(data)
      if (!match) throw new Error('图片数据格式无效')
      const bytes = Uint8Array.from(atob(data.slice(match[0].length)), (character) => character.charCodeAt(0))
      url = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
      setSource(url)
    }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true; if (url) URL.revokeObjectURL(url) }
  }, [active, load, revision])

  return <>
    <button ref={card} className="task-image-preview" onClick={() => { if (error) setRevision((value) => value + 1); else if (source) setSelected(true) }} aria-label={error ? `重新加载 ${name}` : `查看 ${name}`} title={error || name} type="button">
      {source && !error ? <img alt={name} src={source} decoding="async" onError={() => setError('图片无法解码，请打开原文件检查')} /> : <span>{error ? '图片加载失败，点击重试' : visible ? '正在加载图片…' : '滚动到此处查看图片'}</span>}
      {dimensions && <small>{dimensions}</small>}
    </button>
    {selected && source && !error && createPortal(<div ref={dialog} aria-label={`查看 ${name}`} aria-modal="true" className="task-visual-lightbox" onClick={() => setSelected(false)} role="dialog">
      <button aria-label="关闭图片" onClick={() => setSelected(false)} title="关闭图片" type="button"><X size={18} /></button>
      <img alt={name} onClick={(event) => event.stopPropagation()} src={source} />
    </div>, document.body)}
  </>
}
