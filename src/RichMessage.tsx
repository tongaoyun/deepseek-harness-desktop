import { Check, Copy, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
  assistant: boolean
  onRegenerate?: () => void
}

export function RichMessage({ text, assistant, onRegenerate }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return <>
    <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
    {assistant && !text.startsWith('正在') && <div className="message-actions">
      <button aria-label={copied ? '已复制' : '复制回答'} onClick={() => void copy()} title={copied ? '已复制' : '复制'} type="button">{copied ? <Check size={17} /> : <Copy size={17} />}</button>
      {onRegenerate && <button aria-label="重新回答" onClick={onRegenerate} title="重新回答" type="button"><RotateCcw size={17} /></button>}
    </div>}
  </>
}
