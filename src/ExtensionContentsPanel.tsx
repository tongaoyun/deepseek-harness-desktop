import { useEffect, useRef, useState } from 'react'
import { X, FileText, ArrowRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { readExtensionContents, type ExtensionContents, type ExtensionDocument } from './expertKits'
import type { InstalledExpertKit } from './types'
import { useDialogFocus } from './useDialogFocus'

export function ExtensionContentsPanel({ extension }: { extension: InstalledExpertKit }) {
  const { kind, id, version } = extension.manifest
  const [result, setResult] = useState<{ key: string; contents?: ExtensionContents; error?: string }>()
  const [active, setActive] = useState<ExtensionDocument>()
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog, active?.path ?? '', () => setActive(undefined))
  const key = `${kind}:${id}@${version}`
  useEffect(() => {
    let current = true
    setActive(undefined)
    readExtensionContents(kind, id, version).then((contents) => { if (current) setResult({ key, contents }) }, (reason) => { if (current) setResult({ key, error: reason instanceof Error ? reason.message : String(reason) }) })
    return () => { current = false }
  }, [kind, id, version, key])
  if (result?.key !== key) return <p role="status">正在读取扩展原文…</p>
  if (result.error) return <p className="kit-error" role="alert">{result.error}</p>
  const contents = result.contents!
  return <section className="expert-detail-section extension-source-section">
    <h3>{kind === 'skill' ? '技能说明' : '套件内容'}</h3>
    {kind === 'skill' && contents.skills[0] ? <Markdown content={contents.skills[0].content} /> : <>
      <div className="extension-source-list">{contents.skills.map((item) => <button key={item.path} onClick={() => setActive(item)} type="button"><FileText size={16} /><span><strong>{item.name}</strong><small>{item.path}</small></span><ArrowRight size={14} /></button>)}</div>
      {contents.commands.length > 0 && <details><summary>查看 {contents.commands.length} 个命令的执行说明</summary><div className="extension-source-list">{contents.commands.map((item) => <button key={item.path} onClick={() => setActive(item)} type="button"><FileText size={16} /><span>/{item.id}</span><ArrowRight size={14} /></button>)}</div></details>}
      {contents.readme && <details className="extension-readme"><summary>查看完整套件说明</summary><Markdown content={contents.readme} /></details>}
    </>}
    {active && <div className="expert-modal-backdrop" onMouseDown={() => setActive(undefined)} role="presentation"><section ref={dialog} aria-label={active.name} aria-modal="true" className="extension-source-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog"><header><strong>{active.name}</strong><button aria-label="关闭原文" onClick={() => setActive(undefined)} type="button"><X size={17} /></button></header><p>以下内容来自 {active.path} 原文</p><Markdown content={active.content} /></section></div>}
  </section>
}

function Markdown({ content }: { content: string }) {
  return <div className="message-markdown extension-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')}</ReactMarkdown></div>
}
