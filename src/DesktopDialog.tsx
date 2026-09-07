import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDialogFocus } from './useDialogFocus'

interface ConfirmationOptions {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

interface ConfirmationRequest extends ConfirmationOptions {
  resolve: (confirmed: boolean) => void
}

export function useDesktopDialog() {
  const [request, setRequest] = useState<ConfirmationRequest>()
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' }>()
  const toastTimer = useRef<number | undefined>(undefined)

  const confirm = useCallback((options: ConfirmationOptions) => new Promise<boolean>((resolve) => {
    setRequest((current) => {
      current?.resolve(false)
      return { ...options, resolve }
    })
  }), [])

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    window.clearTimeout(toastTimer.current)
    setToast({ message, tone })
    toastTimer.current = window.setTimeout(() => setToast(undefined), 4_000)
  }, [])

  const settle = useCallback((confirmed: boolean) => {
    setRequest((current) => {
      current?.resolve(confirmed)
      return undefined
    })
  }, [])
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, request ? 'confirmation' : '', () => settle(false))

  useEffect(() => () => {
    window.clearTimeout(toastTimer.current)
    request?.resolve(false)
  }, [request])

  const dialog = request ? <div className="desktop-dialog-backdrop" onMouseDown={(event) => {
    event.stopPropagation()
    if (event.target === event.currentTarget) settle(false)
  }}>
    <section aria-labelledby="desktop-dialog-title" aria-modal="true" className="desktop-dialog" ref={dialogRef} role="dialog">
      <button aria-label="关闭" className="desktop-dialog-close" onClick={() => settle(false)} type="button"><X size={18} /></button>
      <h2 id="desktop-dialog-title">{request.title}</h2>
      <p>{request.message}</p>
      <div className="desktop-dialog-actions">
        <button onClick={() => settle(false)} type="button">取消</button>
        <button className={request.danger ? 'danger' : 'primary'} onClick={() => settle(true)} type="button">{request.confirmLabel ?? '确认'}</button>
      </div>
    </section>
  </div> : null

  const toastHost = toast ? <div aria-live="polite" className={`desktop-toast ${toast.tone}`}>
    {toast.tone === 'error' ? <CircleAlert size={17} /> : <CircleCheck size={17} />}
    <span>{toast.message}</span><button aria-label="关闭提示" onClick={() => setToast(undefined)} type="button"><X size={15} /></button>
  </div> : null

  return { confirm, dialog, notify, toast: toastHost }
}
