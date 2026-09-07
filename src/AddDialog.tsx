import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useDialogFocus } from './useDialogFocus'
import './additionFlows.css'

export function AddDialog({ title, description, busy = false, onClose, children, className = '' }: { title: string; description?: string; busy?: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref, title, () => { if (!busy) onClose() })
  return <div className="add-dialog-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`add-dialog ${className}`}>
    <button className="add-dialog-close" type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={17} /></button>
    <header><h2>{title}</h2>{description && <p>{description}</p>}</header>{children}
  </div></div>
}
