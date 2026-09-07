import { Check, Copy, RotateCcw } from 'lucide-react'
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
  assistant: boolean
  onRegenerate?: () => void
}

export const RichMessage = memo(function RichMessage({ text, assistant, onRegenerate }: Props) {
  return <>
    <div className="message-markdown"><ReactMarkdown components={{ pre: CodeBlock }} remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
    {assistant && <div className="message-actions">
      <CopyButton label="复制回答" text={text} />
      {onRegenerate && <button aria-label="编辑后重发" onClick={onRegenerate} title="将原问题和附件放回输入框，修改后发送" type="button"><RotateCcw size={17} /></button>}
    </div>}
  </>
})

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement)
  const props = code?.props as { className?: string; children?: ReactNode } | undefined
  const language = props?.className?.match(/language-([\w+-]+)/)?.[1] ?? '代码'
  const text = typeof props?.children === 'string' ? props.children.replace(/\n$/, '') : ''
  return <div className="message-code-block"><header><span>{language}</span><CopyButton label="复制代码" text={text} /></header><pre>{children}</pre></div>
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    window.clearTimeout(timer.current)
    try { await navigator.clipboard.writeText(text); setState('copied') }
    catch { setState('error') }
    timer.current = window.setTimeout(() => setState('idle'), 2_000)
  }
  const title = state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请重试' : label
  return <span className="copy-control"><button aria-label={title} onClick={() => void copy()} title={title} type="button">{state === 'copied' ? <Check size={16} /> : <Copy size={16} />}</button>{state !== 'idle' && <small role="status">{title}</small>}</span>
}
