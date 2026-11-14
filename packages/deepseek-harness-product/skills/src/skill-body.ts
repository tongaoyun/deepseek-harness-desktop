import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './client-types.ts'
import { TextArea } from './plugin-ui.ts'

/**
 * Read and copy the exact skill body. Clipboard replies belong to the displayed
 * body; closing the reader or replacing its content discards late feedback.
 * Copying preserves the button label, appearance and focus; the native synchronous
 * clipboard fallback restores its original control before returning. Retry retains failure feedback.
 * @param props - skill text and the skills page's localized labels.
 * @returns the read-only body and its copy control.
 */
export function SkillBody(props: { body: string; t: Translate }): React.ReactElement {
  const [status, setStatus] = React.useState<{ pending: boolean; feedback?: 'copied' | 'failed' }>({ pending: false })
  const operation = React.useRef<{ pending: boolean } | null>(null)
  React.useEffect(() => {
    operation.current = { pending: false }
    setStatus({ pending: false })
    return () => { operation.current = null }
  }, [props.body])
  function copy(event: React.MouseEvent<HTMLButtonElement>): void {
    const current = operation.current
    if (!current || current.pending || !props.body) return
    current.pending = true
    setStatus(previous => ({ ...previous, pending: true }))
    const focused = event.currentTarget.ownerDocument.activeElement
    const completion = writeClipboard(props.body)
    if (focused instanceof HTMLElement && focused.isConnected && focused.ownerDocument.activeElement !== focused) {
      focused.focus({ preventScroll: true })
    }
    void completion.then((accepted) => {
      if (operation.current !== current) return
      current.pending = false
      setStatus({ pending: false, feedback: accepted ? 'copied' : 'failed' })
    })
  }
  return React.createElement(React.Fragment, null,
    props.body ? React.createElement('div', { className: 'dssm-detail-actions' },
      status.feedback ? React.createElement('span', { role: status.feedback === 'failed' ? 'alert' : 'status' },
        props.t(status.feedback === 'failed' ? 'detail.copyFailed' : 'detail.copied')) : null,
      React.createElement(Button, { variant: 'outline', size: 'sm', 'aria-disabled': status.pending,
        className: status.pending ? 'product-control-pending' : undefined,
        'aria-busy': status.pending, onClick: copy }, props.t('detail.copyBody'))) : null,
    React.createElement(TextArea, { className: 'dssm-detail-body', 'aria-label': props.t('detail.body'),
      readOnly: true, value: props.body, rows: 16 }))
}
