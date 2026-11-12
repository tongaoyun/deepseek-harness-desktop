import { Button, Input, Modal } from './plugin-ui.ts'
import React from 'react'

/** 提示词预览，复用原生弹窗的焦点管理。 */
export function PromptDialog(props: {
  readonly value: { name: string; prompt: string }
  readonly title: string
  readonly closeLabel: string
  readonly onClose: () => void
}): React.ReactElement {
  return React.createElement(Modal, {
    open: true,
    title: props.title,
    onClose: props.onClose,
    footer: [
      React.createElement(Button, { key: 'close', variant: 'primary', 'data-modal-autofocus': true, onClick: props.onClose }, props.closeLabel),
    ],
  }, React.createElement(Input.TextArea, {
    className: 'aag-prompt-body',
    readOnly: true,
    value: props.value.prompt,
    'aria-label': props.title,
    style: { height: 'min(560px, calc(100vh - 220px))', minHeight: 240, resize: 'none', overflow: 'auto' },
  }))
}
