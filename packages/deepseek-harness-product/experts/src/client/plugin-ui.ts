import {
  Button as PrimitiveButton,
  Input as PrimitiveInput,
  Modal as PrimitiveModal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import React from 'react'

/** 宿主没有多行输入。令牌对齐单行 Input，不桥接成 Ant TextArea。 */
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
}: {
  open?: boolean
  title: string
  description?: string
  children?: React.ReactNode
  footer?: React.ReactNode
  onClose: () => void
  className?: string
  contentClassName?: string
  closeLabel?: string
}): React.ReactElement | null {
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

/** 原生按钮负责属性与图标；产品仅增加危险态和忙碌态。 */
export function Button({ variant = 'outline', danger, loading, className, ...props }: ButtonProps): React.ReactElement {
  const classes = [
    'aag-host-btn',
    'aag-theme',
    className,
    danger ? 'is-danger' : '',
    loading ? 'is-loading' : '',
  ].filter(Boolean).join(' ')
  return React.createElement(PrimitiveButton, {
    ...props,
    variant,
    className: classes,
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
.aag-theme button.is-loading{position:relative;pointer-events:none;color:transparent!important}
.aag-theme button.is-loading::after{content:"";position:absolute;width:14px;height:14px;top:50%;left:50%;margin:-7px 0 0 -7px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:aag-spin .6s linear infinite;color:var(--dsw-alias-label-primary)}
@keyframes aag-spin{to{transform:rotate(360deg)}}
.aag-theme button.is-danger.is-loading::after{color:var(--dsw-alias-state-error-primary,#ef4444)}
.mpi-busy{height:2px;margin:8px 0 0;border-radius:999px;background:var(--dsw-alias-brand-primary);animation:aag-spin 1s linear infinite}
`
