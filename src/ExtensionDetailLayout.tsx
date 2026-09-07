import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function ExtensionDetailLayout({ titleId, onClose, actions, children }: {
  titleId: string; onClose: () => void; actions: ReactNode; children: ReactNode
}) {
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus({ preventScroll: true }) }, [])
  return <section aria-labelledby={titleId} className="extension-detail-page">
    <header className="extension-detail-toolbar">
      <button className="detail-back" onClick={onClose} ref={back} type="button"><ArrowLeft size={15} />返回列表</button>
      <div className="expert-modal-actions">{actions}</div>
    </header>
    <div className="extension-detail-body">{children}</div>
  </section>
}
