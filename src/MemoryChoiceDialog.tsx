import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './useDialogFocus'

interface Choice { id: string; label: string }
interface Request { title: string; description: string; choices: Choice[]; resolve: (id: string | undefined) => void }
export function useMemoryChoice() {
  const [request, setRequest] = useState<Request>()
  const [selected, setSelected] = useState('')
  const pending = useRef<Request | undefined>(undefined)
  const element = useRef<HTMLElement>(null)
  const finish = (id?: string) => { pending.current?.resolve(id); pending.current = undefined; setRequest(undefined) }
  const choose = (title: string, description: string, choices: Choice[]) => new Promise<string | undefined>((resolve) => {
    pending.current?.resolve(undefined)
    const next = { title, description, choices, resolve }
    pending.current = next; setSelected(''); setRequest(next)
  })
  useEffect(() => () => { pending.current?.resolve(undefined) }, [])
  useDialogFocus(element, request ? 'memory-choice' : '', () => finish())
  const dialog = request ? createPortal(<div className="desktop-dialog-backdrop"><section className="desktop-dialog memory-choice" ref={element} role="dialog" aria-modal="true" aria-labelledby="memory-choice-title">
    <h2 id="memory-choice-title">{request.title}</h2><p>{request.description}</p>
    <div className="memory-choice-list">{request.choices.map((item) => <label key={item.id}><input type="radio" name="memory-choice" checked={selected === item.id} onChange={() => setSelected(item.id)} /><span>{item.label}</span></label>)}</div>
    <div className="desktop-dialog-actions"><button type="button" onClick={() => finish()}>取消</button><button className="primary" type="button" disabled={!selected} onClick={() => finish(selected)}>确认选择</button></div>
  </section></div>, document.body) : null
  return { choose, dialog }
}
