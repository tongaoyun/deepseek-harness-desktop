import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { readExtensionContents, type ExtensionContents, type ExtensionDocument } from './expertKits'
import { extensionCommandSlashLabel } from './extensionInvocations'
import type { InstalledExpertKit } from './types'
import { ExtensionReaderDialog } from './ExtensionReaderDialog'
import { ExtensionMarkdown as Markdown, ExtensionReadmeSection } from './ExtensionReadmeSection'

export function ExtensionContentsPanel({ extension, onUseCommand, afterSkills }: {
  extension: InstalledExpertKit; onUseCommand?: (id: string) => void; afterSkills?: ReactNode
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
  return <>
    {contents.commands.length > 0 && <section className="expert-detail-section">
      <h3>快捷命令 <small>({contents.commands.length})</small></h3>
      <div className="detail-command-list">
        {contents.commands.map((item, index) => <button aria-label={`使用命令：${item.name}`} disabled={!enabled || !onUseCommand} key={`command:${item.path}`} onClick={() => onUseCommand?.(item.id)} type="button"><code>{slashCommand(item.name, item.id, index)}</code><span>{item.summary}</span><ArrowRight size={15} /></button>)}
      </div>
    </section>}
    {contents.skills.length > 0 && <section className="expert-detail-section extension-source-section">
      <h3>技能 <small>({contents.skills.length})</small></h3>
      <div className="extension-source-list">{contents.skills.map((item) => <button aria-label={`技能：${item.name}`} key={item.path} onClick={() => setActive(item)} type="button"><span><strong>{item.name}</strong>{item.summary && <small>{item.summary}</small>}</span></button>)}</div>
    </section>}
    {afterSkills}
    <ExtensionReadmeSection readme={contents.readme} />
    {active && <ExtensionReaderDialog title={active.name} onClose={() => setActive(undefined)} heading={<><h2>{active.name}</h2><p className="extension-reader-meta">来自 {extension.manifest.name} · {id}</p>{active.summary && <p className="extension-reader-summary">{active.summary}</p>}</>}><Markdown content={active.content} /></ExtensionReaderDialog>}
  </>
}

function slashCommand(name: string, id: string, index: number): string {
  const normalized = name.replace(/^\/+/, '')
  return `/${normalized === id ? extensionCommandSlashLabel(id, index) : normalized}`
}
