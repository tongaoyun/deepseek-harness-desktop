import { Check, Copy } from 'lucide-react'
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
}

/** Markdown body only. Per-turn actions live in the turn footer, once. */
export const RichMessage = memo(function RichMessage({ text }: Props) {
  return <div className="message-markdown"><ReactMarkdown components={{ pre: CodeBlock }} remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
})

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement)
  const props = code?.props as { className?: string; children?: ReactNode } | undefined
  const language = props?.className?.match(/language-([\w+-]+)/)?.[1] ?? '代码'
  const text = typeof props?.children === 'string' ? props.children.replace(/\n$/, '') : ''
  return <div className="message-code-block"><header><span className="code-language">{language}</span><small>{text.split('\n').length} 行</small><CopyButton label="复制代码" text={text} /></header><pre>{children}</pre></div>
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
