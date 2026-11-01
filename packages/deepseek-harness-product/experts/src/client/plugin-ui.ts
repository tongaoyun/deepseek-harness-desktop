import {
  Button as PrimitiveButton,
  Input as PrimitiveInput,
  Modal as PrimitiveModal,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import React from 'react'

/** 多行输入使用标准 textarea 属性和产品输入样式。 */
export function TextArea({ rows = 3, className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  const classes = ['aag-textarea', className].filter(Boolean).join(' ')
  return React.createElement('textarea', { ...props, rows, className: classes })
}

/** 单行输入沿用原生属性，多行表单使用产品 TextArea。 */
export function Input({ className, ...props }: React.ComponentPropsWithoutRef<typeof PrimitiveInput>): React.ReactElement {
  const classes = ['aag-host-input', className].filter(Boolean).join(' ')
  return React.createElement(PrimitiveInput, { ...props, className: classes })
}
Input.TextArea = TextArea

type NativeModalProps = Extract<React.ComponentProps<typeof PrimitiveModal>, { headless?: false }>
type ModalProps = Pick<NativeModalProps, 'title' | 'description' | 'children' | 'footer' | 'onClose' | 'className' | 'contentClassName'>
  & Partial<Pick<NativeModalProps, 'open' | 'closeLabel'>>

/**
 * 弹窗关闭沿用原生 onClose；产品只补齐主题和关闭按钮文案。
 * closeLabel 只用于右上角的 ×：必须是「关闭弹窗」这类独立文案，复用例文会和页脚动作重名。
 */
export function Modal({
  open = true,
  title,
  description,
  children,
  footer,
  onClose,
  className,
  contentClassName,
  closeLabel,
}: ModalProps): React.ReactElement | null {
  return React.createElement(PrimitiveModal, {
    open,
    title,
    description,
    footer,
    closeLabel: closeLabel ?? (documentUiLocale() === 'en' ? 'Close dialog' : '关闭弹窗'),
    className: ['aag-theme', 'aag-host-modal', className].filter(Boolean).join(' '),
    contentClassName,
    onClose,
  }, children)
}

type ButtonProps = React.ComponentPropsWithoutRef<typeof PrimitiveButton> & {
  /** 原生 Modal 在记录打开按钮后聚焦此控件。 */
  'data-modal-autofocus'?: boolean
  danger?: boolean
  loading?: boolean
}

/** 原生按钮和加载指示保留操作文案；产品补充危险态，并禁用忙碌操作。 */
export function Button({ variant = 'outline', danger, loading, className, icon, ...props }: ButtonProps): React.ReactElement {
  const classes = [
    'aag-theme',
    className,
    danger ? 'is-danger' : '',
  ].filter(Boolean).join(' ')
  return React.createElement(PrimitiveButton, {
    ...props,
    variant,
    className: classes,
    icon: loading ? React.createElement(StateDot, { state: 'ongoing', size: 14 }) : icon,
    'aria-busy': loading || props['aria-busy'],
    disabled: props.disabled || loading,
  })
}

/** 独立挂载的界面按页面语言选择中英文。 */
export function documentUiLocale(): 'zh' | 'en' {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang.toLowerCase()
  return lang.startsWith('en') ? 'en' : 'zh'
}

/** 宿主原语接不住的少量版式。确认框保持宿主 380px，长表单只加宽自己的类。 */
export const PLUGIN_UI_CSS = `
.aag-theme .is-danger{color:var(--dsw-alias-state-error-primary,#ef4444)!important;border:0.5px solid var(--dsw-alias-state-error-primary,#ef4444)!important;background:transparent!important}
.aag-theme .is-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-tertiary,rgba(239,68,68,0.15))!important;color:var(--dsw-alias-state-error-primary,#ef4444)!important;border-color:var(--dsw-alias-state-error-primary,#ef4444)!important}
.aag-host-input{box-sizing:border-box}
.aag-textarea{box-sizing:border-box;width:100%;min-width:0;padding:8px 12px;font:inherit;font-size:13px;line-height:20px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);resize:vertical;transition:border-color 120ms ease}
.aag-textarea:focus,.aag-textarea:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:0;border-color:var(--dsw-alias-brand-primary)}
.aag-host-modal.aag-editor-modal,.aag-host-modal.agt-editor-modal,.aag-host-modal.agt-picker,.aag-host-modal.agt-detail{width:min(760px,100%)!important;max-height:100%!important}
.aag-menu-select-trigger{display:inline-flex!important;align-items:center;justify-content:space-between;gap:6px;width:auto!important;max-width:100%;min-width:0!important;height:32px!important;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-sizing:border-box;font:inherit;font-size:13px;cursor:pointer}
.aag-select-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:normal;text-align:left}
.aag-native-select-arrow{flex:none;margin-left:4px;transition:transform 150ms ease}
.aag-menu-select-trigger[aria-expanded=true] .aag-native-select-arrow{transform:rotate(180deg)}
`
