import { Copy, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
  assistant: boolean
  onRegenerate?: () => void
}

export function RichMessage({ text, assistant, onRegenerate }: Props) {
  return <>
    <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
    {assistant && !text.startsWith('正在') && <div className="message-actions">
      <button onClick={() => void navigator.clipboard.writeText(text)} type="button"><Copy size={13} />复制</button>
      {onRegenerate && <button onClick={onRegenerate} type="button"><RotateCcw size={13} />重新生成</button>}
    </div>}
  </>
}
