import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExtensionReaderDialog } from './ExtensionReaderDialog'

/** The kit's own guide, shown as a bounded preview that opens the full text in a dialog. */
export function ExtensionReadmeSection({ readme }: { readme: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [readme])
  if (!readme) return null
  return <>
    <section className="expert-detail-section extension-readme">
      <div className="extension-readme-preview" role="button" tabIndex={0} aria-label="查看完整套件说明" aria-haspopup="dialog" onClick={() => setOpen(true)} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(true) }
      }}>
        <h3><FileText size={16} />套件说明</h3>
        <div inert aria-hidden="true"><ExtensionMarkdown content={readme} /></div>
      </div>
    </section>
    {open && <ExtensionReaderDialog title="套件说明" onClose={() => setOpen(false)} heading={<h2 className="extension-reader-title"><FileText size={20} />套件说明</h2>}><ExtensionMarkdown content={readme} /></ExtensionReaderDialog>}
  </>
}

export function ExtensionMarkdown({ content }: { content: string }) {
  return <div className="message-markdown extension-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')}</ReactMarkdown></div>
}
