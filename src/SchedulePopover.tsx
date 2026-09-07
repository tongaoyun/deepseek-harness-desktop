import { useEffect, useRef, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export function SchedulePopover({ label, trigger, children, className = '', onOpen }: {
  label: string; trigger: ReactNode; children: (close: () => void) => ReactNode; className?: string; onOpen?: () => void
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const close = () => { if (ref.current) ref.current.open = false }
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  return <details ref={ref} className={`schedule-popover ${className}`} data-popover onToggle={() => {
    if (ref.current?.open) {
      document.querySelectorAll<HTMLDetailsElement>('details[data-popover][open]').forEach((item) => { if (item !== ref.current) item.open = false })
      onOpen?.()
    }
  }} onKeyDown={(e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); ref.current?.querySelector('summary')?.focus() }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.target instanceof HTMLInputElement) return
    e.preventDefault(); if (ref.current) ref.current.open = true
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('.schedule-popover-content button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : index < 0 ? (e.key === 'ArrowUp' ? buttons.length - 1 : 0) : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus()
  }}><summary aria-label={label}>{trigger}</summary><div className="schedule-popover-content">{children(() => { close(); ref.current?.querySelector('summary')?.focus() })}</div></details>
}

export function ScheduleSelect({ label, value, options, onChange, className = '' }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; className?: string
}) {
  return <SchedulePopover label={label} className={`schedule-select ${className}`} trigger={<><span>{options.find((item) => item.value === value)?.label ?? value}</span><ChevronDown size={13} /></>}>
    {(close) => <div role="menu" aria-label={label}>{options.map((item) => <button type="button" role="menuitemradio" aria-checked={value === item.value} key={item.value} onClick={() => { onChange(item.value); close() }}><span>{item.label}</span>{value === item.value && <Check size={13} />}</button>)}</div>}
  </SchedulePopover>
}
