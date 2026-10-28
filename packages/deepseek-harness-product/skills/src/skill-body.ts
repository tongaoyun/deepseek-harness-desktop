import React from 'react'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './client-types.ts'
import { TextArea } from './plugin-ui.ts'

/**
 * Read and copy the exact skill body. Clipboard replies belong to the displayed
 * body; closing the reader or replacing its content discards late feedback.
 * @param props - skill text and the skills page's localized labels.
 * @returns the read-only body and its copy control.
 */
export function SkillBody(props: { body: string; t: Translate }): React.ReactElement {
  const [status, setStatus] = React.useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const operation = React.useRef<{ pending: boolean } | null>(null)
  React.useEffect(() => {
    operation.current = { pending: false }
    setStatus('idle')
    return () => { operation.current = null }
  }, [props.body])
  function copy(): void {
    const current = operation.current
    if (!current || current.pending || !props.body) return
    current.pending = true
    setStatus('copying')
    void writeClipboard(props.body).then((accepted) => {
      if (operation.current !== current) return
      current.pending = false
      setStatus(accepted ? 'copied' : 'failed')
    })
  }
  const key = status === 'idle' ? 'detail.copyBody' : status === 'failed' ? 'detail.copyFailed' : `detail.${status}`
  return React.createElement(React.Fragment, null,
    props.body ? React.createElement('div', { className: 'dssm-detail-actions' },
      React.createElement(Button, { variant: 'outline', size: 'sm', disabled: status === 'copying',
        'aria-live': 'polite', onClick: copy }, props.t(key))) : null,
    React.createElement(TextArea, { className: 'dssm-detail-body', 'aria-label': props.t('detail.body'),
      readOnly: true, value: props.body, rows: 16 }))
}
