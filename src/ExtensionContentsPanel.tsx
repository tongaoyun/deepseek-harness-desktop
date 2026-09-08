import { useEffect, useState } from 'react'
import { FileText, ArrowRight, MessageSquare } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { readExtensionContents, type ExtensionContents, type ExtensionDocument } from './expertKits'
import type { InstalledExpertKit } from './types'
import { ExtensionReaderDialog } from './ExtensionReaderDialog'

export function ExtensionContentsPanel({ extension, onUseSkill, onUseCommand, onCustomize }: {
  extension: InstalledExpertKit; onUseSkill?: (skill: ExtensionDocument) => void; onUseCommand?: (id: string) => void; onCustomize?: () => void
}) {
  const { kind, id, version } = extension.manifest
  const [result, setResult] = useState<{ key: string; contents?: ExtensionContents; error?: string }>()
  const [active, setActive] = useState<ExtensionDocument>()
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
  if (kind === 'skill') return contents.skills[0] ? <Markdown content={contents.skills[0].content} /> : <p>暂无技能说明</p>
  const enabled = extension.enabled !== false
  const shortcuts = contents.skills.filter((skill) => skill.userInvocable)
  const useActiveSkill = enabled && active?.userInvocable && contents.skills.includes(active) ? onUseSkill : undefined
  return <>
    {(shortcuts.length > 0 || contents.commands.length > 0) && <section className="expert-detail-section">
      <h3>快捷命令 <small>({shortcuts.length + contents.commands.length})</small></h3>
      <div className="detail-command-list">
        {contents.commands.map((item) => <button aria-label={`使用命令：${item.name}`} disabled={!enabled || !onUseCommand} key={`command:${item.path}`} onClick={() => onUseCommand?.(item.id)} type="button"><code>/{item.name}</code><span>{item.summary}</span><ArrowRight size={15} /></button>)}
        {shortcuts.map((item) => <button aria-label={`使用技能：${item.name}`} disabled={!enabled || !onUseSkill} key={item.path} onClick={() => onUseSkill?.(item)} type="button"><code>/{item.name}</code><span>{item.summary}</span><ArrowRight size={15} /></button>)}
      </div>
    </section>}
    {contents.skills.length > 0 && <section className="expert-detail-section extension-source-section">
      <h3>知识技能 <small>({contents.skills.length})</small></h3>
      <div className="extension-source-list">{contents.skills.map((item) => <button aria-label={`知识技能：${item.name}`} key={item.path} onClick={() => setActive(item)} type="button"><FileText size={16} /><span><strong>{item.name}</strong>{item.summary && <small>{item.summary}</small>}</span><ArrowRight size={14} /></button>)}</div>
    </section>}
    {contents.commands.length > 0 && <section className="expert-detail-section extension-source-section">
      <h3>命令说明 <small>({contents.commands.length})</small></h3>
      <div className="extension-source-list">{contents.commands.map((item) => <button key={item.path} onClick={() => setActive(item)} type="button"><FileText size={16} /><span><strong>{item.name}</strong>{item.summary && <small>{item.summary}</small>}</span><ArrowRight size={14} /></button>)}</div>
    </section>}
    {contents.readme && <section className="expert-detail-section extension-readme"><h3>套件说明</h3><Markdown content={contents.readme} /></section>}
    {active && <ExtensionReaderDialog title={active.name} onClose={() => setActive(undefined)} heading={<><h2>{active.name}</h2><p className="extension-reader-meta">来自 {extension.manifest.name} · v{version}</p>{active.summary && <p className="extension-reader-summary">{active.summary}</p>}</>} actions={(onCustomize || useActiveSkill) ? <>
      {onCustomize && <button className="secondary" onClick={onCustomize} type="button">自定义修改</button>}
      {useActiveSkill && <button onClick={() => useActiveSkill(active)} type="button"><MessageSquare size={14} />使用技能</button>}
    </> : undefined}><Markdown content={active.content} /></ExtensionReaderDialog>}
  </>
}

function Markdown({ content }: { content: string }) {
  return <div className="message-markdown extension-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')}</ReactMarkdown></div>
}
