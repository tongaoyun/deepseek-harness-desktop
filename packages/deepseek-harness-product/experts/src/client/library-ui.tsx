import { Button, Modal } from './plugin-ui.ts'
import { Switch as PrimitiveSwitch, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import React from 'react'

/** 控件移除后，将其仍持有的焦点交还当前内容，不滚动或抢占其他控件。
 * @param getTarget 结果提交后仍存在的焦点目标。
 * @returns 当前焦点按钮使用的稳定 ref。
 */
export function useLibraryRemovalFocus(getTarget: () => HTMLElement | null | undefined): React.RefCallback<HTMLButtonElement> {
  const control = React.useRef<HTMLButtonElement | null>(null)
  const removed = React.useRef<HTMLButtonElement>()
  const ref = React.useCallback((node: HTMLButtonElement | null) => {
    const previous = control.current
    if (!node && previous && previous.ownerDocument.activeElement === previous) removed.current = previous
    control.current = node
  }, [])
  React.useLayoutEffect(() => {
    const previous = removed.current
    removed.current = undefined
    if (!previous || previous.ownerDocument.activeElement !== previous.ownerDocument.body) return
    const target = getTarget()
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  return ref
}

/** 写入结束或弹窗移除后恢复当前目录丢失的焦点，控件移除时进入搜索，不抢占其他控件。
 * @param pending 写入及结果确认是否仍在等待。
 * @param scope 当前可见目录；切换目录后不恢复旧焦点。
 * @param area 动作所属目录，用于确定当前文档。
 * @param getTarget 条目移除后的搜索入口。
 * @returns 写入前或弹窗移除前捕获当前焦点的函数。
 */
export function useLibraryActionFocus(
  pending: boolean, scope: string, area: React.RefObject<HTMLElement>, getTarget: () => HTMLElement | null | undefined,
): () => void {
  const captured = React.useRef<{ element: HTMLElement; scope: string }>()
  React.useLayoutEffect(() => {
    const previous = captured.current
    if (pending || !previous) return
    captured.current = undefined
    const { element } = previous
    if (previous.scope !== scope || element.ownerDocument.activeElement !== element.ownerDocument.body) return
    const target = element !== element.ownerDocument.body && element.isConnected && !element.matches(':disabled') && !element.closest('[hidden]') ? element : getTarget()
    if (target && !target.closest('[hidden]')) focusWithoutRing(target, { preventScroll: true })
  })
  return () => {
    const element = area.current?.ownerDocument.activeElement
    if (element instanceof HTMLElement) {
      captured.current = { element, scope }
    }
  }
}

export interface LibraryMenuItem {
  id: string
  label: string
  shortLabel?: string
  icon?: React.ReactNode
  disabled?: boolean
  pending?: boolean
  danger?: boolean
  onSelect(): void
}

/** 防止刷新窗口丢失编辑内容或中断尚未确认的保存。
 * @param unresolved 是否存在未保存内容或在途操作。
 */
export function useLibraryUnloadGuard(unresolved: boolean): void {
  React.useEffect(() => {
    if (!unresolved) return
    const preventUnload = (event: BeforeUnloadEvent): void => { event.preventDefault() }
    window.addEventListener('beforeunload', preventUnload)
    return () => { window.removeEventListener('beforeunload', preventUnload) }
  }, [unresolved])
}

/** 保存期间保留按钮和键盘焦点；仅提交按钮显示进度，错误显示在固定操作区。 */
export function LibraryEditorFooter(props: {
  editing: boolean
  busy: boolean
  saving: 'save' | 'primary' | false
  blocked?: boolean
  error?: string
  help: string
  cancelLabel: string
  saveLabel: string
  primaryLabel: string
  pendingLabel: string
  close(): void
  save(): void
  primary(): void
  inert?: boolean
}) {
  return (
    <footer
      className="aag-custom-footer"
      {...(props.inert ? { inert: '' } : {})}
    >
      {props.error && <p className="aag-error" role="alert">{props.error}</p>}
      <p className="aag-note">{props.help}</p>
      <div>
        <Button aria-disabled={props.busy} className={props.busy ? 'product-control-pending' : undefined}
          onClick={() => { if (!props.busy) props.close() }}>{props.cancelLabel}</Button>
        {!props.editing && (
          <Button disabled={props.blocked} aria-disabled={props.busy || props.blocked} aria-busy={props.saving === 'save'}
            className={props.busy && !props.blocked ? 'product-control-pending' : undefined}
            onClick={() => { if (!props.busy && !props.blocked) props.save() }}>{props.saving === 'save' ? props.pendingLabel : props.saveLabel}</Button>
        )}
        <Button variant="primary" disabled={props.blocked} aria-disabled={props.busy || props.blocked} aria-busy={props.saving === 'primary'}
          className={props.busy && !props.blocked ? 'product-control-pending' : undefined}
          onClick={() => { if (!props.busy && !props.blocked) props.primary() }}>{props.saving === 'primary' ? props.pendingLabel : props.primaryLabel}</Button>
      </div>
    </footer>
  )
}

/** 专家与专家团共享卡片结构，业务差异仅由内容和操作传入。 */
export function LibraryCard(props: {
  name: string
  avatar: React.ReactNode
  metadata: React.ReactNode
  description: string
  enabled: boolean
  disabled?: boolean
  pending?: boolean
  enabledLabel: string
  disabledLabel: string
  toggle(): void
  actions: React.ReactNode
  moreItems: readonly LibraryMenuItem[]
  testId?: string
}) {
  return (
    <article className="aag-expert-card" data-testid={props.testId}>
      <div className="aag-card-body">
        <div className="aag-card-header">
          {props.avatar}
          <div className="aag-card-identity">
            <div className="aag-card-name" title={props.name}>{props.name}</div>
            <div className="aag-card-description" title={props.description}>{props.description}</div>
          </div>
        </div>
        <div className="aag-card-division">{props.metadata}</div>
      </div>
      <div className="aag-card-actions">
        {props.actions}
        {props.moreItems.map((item) => (
          <button key={item.id} type="button"
            className={['aag-card-action', item.danger ? 'aag-card-action-danger' : '', item.pending && !item.disabled ? 'product-control-pending' : ''].filter(Boolean).join(' ')}
            disabled={item.disabled || item.pending} aria-busy={item.pending} title={item.label} aria-label={item.label}
            onClick={() => item.onSelect()}>
            {item.icon}<span className="aag-card-action-text">{item.shortLabel ?? item.label}</span>
          </button>
        ))}
        <div className="aag-switch" aria-busy={props.pending} onClick={(event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        }}>
          <PrimitiveSwitch
            checked={props.enabled}
            disabled={props.disabled || props.pending}
            className={props.pending && !props.disabled ? 'product-control-pending' : undefined}
            label={`${props.name}：${props.enabled ? props.enabledLabel : props.disabledLabel}`}
            title={props.enabled ? props.enabledLabel : props.disabledLabel}
            onChange={() => props.toggle()}
          />
          <span className="aag-switch-state">
            {props.enabled ? props.enabledLabel : props.disabledLabel}
          </span>
        </div>
      </div>
    </article>
  )
}

/** 删除、放弃修改及启用依赖使用同一种确认弹窗。说明放宿主描述槽，避免正文边距把句子压到按钮上。破坏性操作传 danger，确认键用宿主警示模式的红色描边。 */
export function LibraryConfirm(props: {
  title: string
  description?: string
  children?: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  busy?: boolean
  error?: string | null
  danger?: boolean
  confirm(): void
  close(): void
}) {
  const extra = props.error ? <p className="aag-error" role="alert">{props.error}</p> : null
  const body = props.children || extra ? <>{props.children}{extra}</> : undefined
  return (
    <Modal
      open
      title={props.title}
      description={props.description}
      onClose={() => { if (!props.busy) props.close() }}
      footer={[
        <Button key="cancel" variant="outline" aria-disabled={props.busy} className={props.busy ? 'product-control-pending' : undefined}
          onClick={() => { if (!props.busy) props.close() }}>{props.cancelLabel}</Button>,
        <Button key="confirm" variant={props.danger ? 'outline' : 'primary'} danger={props.danger} aria-disabled={props.busy}
          aria-busy={props.busy} className={props.busy ? 'product-control-pending' : undefined}
          onClick={() => { if (!props.busy) props.confirm() }}>{props.confirmLabel}</Button>,
      ]}
    >
      {body}
    </Modal>
  )
}
