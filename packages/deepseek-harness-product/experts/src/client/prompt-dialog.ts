import { Button, Input, Modal } from './plugin-ui.ts'
import React from 'react'

/** 提示词正文独立滚动，标题和关闭操作保留在视口内；焦点由原生弹窗管理。 */
export function PromptDialog(props: {
  readonly value: { name: string; prompt: string }
  readonly title: string
  readonly closeLabel: string
  readonly onClose: () => void
}): React.ReactElement {
  return React.createElement(Modal, {
    open: true,
    title: props.title,
    className: 'aag-prompt-modal',
    contentClassName: 'aag-prompt-content',
    onClose: props.onClose,
    footer: [
      React.createElement(Button, { key: 'close', variant: 'primary', 'data-modal-autofocus': true, onClick: props.onClose }, props.closeLabel),
    ],
  }, React.createElement(Input.TextArea, {
    className: 'aag-prompt-body',
    readOnly: true,
    value: props.value.prompt,
    'aria-label': props.title,
  }))
}
