import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { ChatPageProps } from './ChatPage'
import { modelDisplayName } from './modelSelection'
import { modelReasoningEfforts, reasoningLabels, resolveReasoningEffort } from './modelReasoning'
import './composerModelPicker.css'

type Props = Pick<ChatPageProps, 'models' | 'activeModel' | 'reasoningEffort' | 'onReasoningEffortChange' | 'modelPickerRef' | 'modelMenuOpen' | 'onToggleModelMenu' | 'onSelectModel'> & { locked: boolean }

export function ComposerModelPicker(props: Props) {
  const [modelsOpen, setModelsOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const modelRow = useRef<HTMLButtonElement>(null)
  const options = useRef<HTMLDivElement>(null)
  const sliderId = useId()
  const efforts = modelReasoningEfforts(props.activeModel)
  const effort = resolveReasoningEffort(props.activeModel, props.reasoningEffort)
  const index = Math.max(0, efforts.indexOf(effort!))
  const open = props.modelMenuOpen && props.models.length > 0 && !props.locked
  useEffect(() => { if (!open) setModelsOpen(false) }, [open])
  useEffect(() => {
    if (!open) return
    modelRow.current?.focus()
  }, [open])
  useEffect(() => { if (modelsOpen) options.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus() }, [modelsOpen])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!props.modelPickerRef.current?.contains(event.target as Node)) props.onToggleModelMenu()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, props.modelPickerRef, props.onToggleModelMenu])

  return <div className="model-picker composer-model-picker" ref={props.modelPickerRef} onKeyDown={(event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (modelsOpen) { setModelsOpen(false); modelRow.current?.focus() }
    else { props.onToggleModelMenu(); trigger.current?.focus() }
  }}>
    <button aria-label="模型与生成模式" aria-haspopup="dialog" aria-expanded={open} className="model-label" disabled={props.locked || !props.models.length} onClick={props.onToggleModelMenu} ref={trigger} type="button">
      <span className="model-trigger-name">{props.models.length ? modelDisplayName(props.activeModel) : '暂无可用模型'}</span>
      {effort && <span className="model-trigger-effort">{reasoningLabels[effort]}</span>}
      <ChevronDown size={12} />
    </button>
    {open && <div className="model-settings-popover" role="dialog" aria-label="模型与生成模式">
      <button className="model-choice-row" ref={modelRow} aria-expanded={modelsOpen} aria-haspopup="listbox" onClick={() => setModelsOpen(true)} onMouseEnter={() => setModelsOpen(true)} onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); setModelsOpen(true) }
      }} type="button"><strong>选择模型</strong><span>{modelDisplayName(props.activeModel)}</span><ChevronRight size={14} /></button>
      {efforts.length > 0 && <div className="model-generation-control">
        <div><label htmlFor={sliderId}>生成模式</label><span>{reasoningLabels[effort!]}</span></div>
        <input id={sliderId} type="range" aria-label="生成模式" aria-valuetext={reasoningLabels[effort!]} min={0} max={efforts.length - 1} step={1} value={index} style={{ '--effort-progress': `${index / (efforts.length - 1) * 100}%` } as CSSProperties} onChange={(event) => props.onReasoningEffortChange?.(efforts[Number(event.target.value)])} />
        <div className="model-effort-stops">{efforts.map((value) => <button type="button" key={value} aria-pressed={value === effort} onClick={() => props.onReasoningEffortChange?.(value)}>{reasoningLabels[value]}</button>)}</div>
      </div>}
      {modelsOpen && <div ref={options} className="model-menu model-choice-submenu" role="listbox" aria-label="选择模型" onKeyDown={(event) => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        }
        if (event.key === 'ArrowLeft') { event.preventDefault(); setModelsOpen(false); modelRow.current?.focus() }
      }}>{props.models.map((model) => <button className={model === props.activeModel ? 'active' : ''} role="option" aria-selected={model === props.activeModel} key={model} onClick={() => { props.onSelectModel(model); trigger.current?.focus() }} title={model} type="button"><strong>{modelDisplayName(model)}</strong>{model === props.activeModel && <Check size={14} />}</button>)}</div>}
    </div>}
  </div>
}
