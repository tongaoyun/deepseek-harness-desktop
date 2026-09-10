import { useEffect, useState, type ReactNode } from 'react'
import { FileText, ArrowRight } from 'lucide-react'
import { readExtensionContents, type ExtensionContents, type ExtensionDocument } from './expertKits'
import type { InstalledExpertKit } from './types'
import { ExtensionReaderDialog } from './ExtensionReaderDialog'
import { ExtensionMarkdown as Markdown, ExtensionReadmeSection } from './ExtensionReadmeSection'

export function ExtensionContentsPanel({ extension, onUseSkill, onUseCommand, beforeSkills }: {
  extension: InstalledExpertKit; onUseSkill?: (skill: ExtensionDocument) => void; onUseCommand?: (id: string) => void; beforeSkills?: ReactNode
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
  return <>
    {(shortcuts.length > 0 || contents.commands.length > 0) && <section className="expert-detail-section">
      <h3>快捷命令 <small>({shortcuts.length + contents.commands.length})</small></h3>
      <div className="detail-command-list">
        {contents.commands.map((item) => <button aria-label={`使用命令：${item.name}`} disabled={!enabled || !onUseCommand} key={`command:${item.path}`} onClick={() => onUseCommand?.(item.id)} type="button"><code>/{item.name}</code><span>{item.summary}</span><ArrowRight size={15} /></button>)}
        {shortcuts.map((item) => <button aria-label={`使用技能：${item.name}`} disabled={!enabled || !onUseSkill} key={item.path} onClick={() => onUseSkill?.(item)} type="button"><code>/{item.name}</code><span>{item.argumentHint || item.summary}</span><ArrowRight size={15} /></button>)}
      </div>
    </section>}
    {beforeSkills}
    {contents.skills.length > 0 && <section className="expert-detail-section extension-source-section">
      <h3>技能 <small>({contents.skills.length})</small></h3>
      <div className="extension-source-list">{contents.skills.map((item) => <button aria-label={`技能：${item.name}`} key={item.path} onClick={() => setActive(item)} type="button"><span><strong>{item.name}</strong>{item.summary && <small>{item.summary}</small>}</span></button>)}</div>
    </section>}
    {contents.commands.length > 0 && <section className="expert-detail-section extension-source-section">
      <h3>命令说明 <small>({contents.commands.length})</small></h3>
      <div className="extension-source-list">{contents.commands.map((item) => <button key={item.path} onClick={() => setActive(item)} type="button"><FileText size={16} /><span><strong>{item.name}</strong>{item.summary && <small>{item.summary}</small>}</span><ArrowRight size={14} /></button>)}</div>
    </section>}
    <ExtensionReadmeSection readme={contents.readme} />
    {active && <ExtensionReaderDialog title={active.name} onClose={() => setActive(undefined)} heading={<><h2>{active.name}</h2><p className="extension-reader-meta">来自 {extension.manifest.name} · {id}</p>{active.summary && <p className="extension-reader-summary">{active.summary}</p>}</>}><Markdown content={active.content} /></ExtensionReaderDialog>}
  </>
}
