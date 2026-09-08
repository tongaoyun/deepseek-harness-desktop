import { X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { useDialogFocus } from './useDialogFocus'

export function ExtensionReaderDialog({ title, onClose, heading, actions, children }: {
  title: string; onClose: () => void; heading?: ReactNode; actions?: ReactNode; children: ReactNode
}) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog, title, onClose)
  return <div className="expert-modal-backdrop extension-reader-backdrop" onMouseDown={onClose} role="presentation">
    <section ref={dialog} aria-label={title} aria-modal="true" className="extension-reader-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <header className="extension-reader-heading">
        <button aria-label="关闭原文" className="extension-reader-close" onClick={onClose} title="关闭" type="button"><X size={18} /></button>
        {heading ?? <h2>{title}</h2>}
      </header>
      <div className="extension-reader-body">{children}</div>
      {actions && <footer className="expert-modal-actions extension-reader-actions">{actions}</footer>}
    </section>
  </div>
}
