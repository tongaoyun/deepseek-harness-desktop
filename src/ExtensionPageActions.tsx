import { Braces, FileUp, PenLine, Plus, RefreshCw, Search, Send, WandSparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseConnectorImport } from './connectorImport'
import type { ConnectorCatalogEntry } from './types'
import { AddDialog } from './AddDialog'

export { parseConnectorJson } from './connectorImport'

type PageKind = 'skills' | 'connectors'

interface Props {
  page: PageKind
  loading: boolean
  query: string
  onQuery: (value: string) => void
  onRefresh: () => void
  onCreate: () => void
  onUpload: () => void
  packageKind?: 'skill' | 'expert-kit'
  connectorIds: string[]
  onImportConnector: (connector: ConnectorCatalogEntry) => Promise<void>
}

export function ExtensionPageActions(props: Props) {
  const [open, setOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [])

  useEffect(() => { setOpen(false) }, [props.page, props.packageKind])
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])

  const noun = props.page === 'skills' ? props.packageKind === 'expert-kit' ? '专家套件' : '技能' : '连接器'
  return <>
    <div className="capability-page-actions" ref={root}>
      <button aria-label="刷新目录" className="refresh-extension-button" disabled={props.loading} onClick={props.onRefresh} title="刷新目录" type="button"><RefreshCw className={props.loading ? 'spin' : ''} size={17} /></button>
      <label className="capability-page-search"><Search size={16} /><input aria-label={`搜索${noun}`} onChange={(event) => props.onQuery(event.target.value)} placeholder={`搜索${noun}…`} value={props.query} />{props.query && <button aria-label="清空搜索" onClick={() => props.onQuery('')} type="button"><X size={13} /></button>}</label>
      <button aria-expanded={open} className="add-extension-button" onClick={() => setOpen((value) => !value)} type="button"><Plus size={17} />添加</button>
      {open && <div className="extension-add-menu" role="menu" onKeyDown={(event) => {
        if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.add-extension-button')?.focus(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }}>
        {props.page !== 'connectors' && <button onClick={() => { setOpen(false); props.onCreate() }} role="menuitem" type="button"><WandSparkles size={18} /><span><strong>通过小胤创建</strong><small>创建个性化{noun}，保存在本机使用</small></span></button>}
        {props.page === 'connectors'
          ? <>
            <button onClick={() => { setOpen(false); props.onCreate() }} role="menuitem" type="button"><PenLine size={18} /><span><strong>手动填写配置</strong><small>填写任意 MCP 服务的连接信息</small></span></button>
            <button onClick={() => { setOpen(false); setJsonOpen(true) }} role="menuitem" type="button"><Braces size={18} /><span><strong>粘贴 JSON 配置</strong><small>导入 MCP 服务配置</small></span></button>
          </>
          : <button disabled={props.loading} onClick={() => { setOpen(false); props.onUpload() }} role="menuitem" type="button"><FileUp size={18} /><span><strong>上传{props.packageKind === 'expert-kit' ? '套件' : noun}</strong><small>导入{noun}文件，仅安装到本机</small></span></button>}
        <button disabled role="menuitem" type="button"><Send size={18} /><span><strong>提交到企业市场</strong><small>创建后可在创作中心提交管理员审核</small></span></button>
      </div>}
    </div>
    {jsonOpen && <ConnectorJsonModal existingIds={props.connectorIds} onClose={() => setJsonOpen(false)} onSave={props.onImportConnector} />}
  </>
}

export function ConnectorJsonModal({ existingIds, onClose, onSave }: { existingIds: string[]; onClose: () => void; onSave: (connector: ConnectorCatalogEntry) => Promise<void> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string[]>([])
  const [failures, setFailures] = useState<Record<string, string>>({})
  const saving = useRef(false)
  const preview = useMemo(() => {
    if (!value.trim()) return { items: [], error: '' }
    try { return { items: parseConnectorImport(value), error: '' } }
    catch (reason) { return { items: [], error: reason instanceof Error ? reason.message : String(reason) } }
  }, [value])
  const pending = preview.items.flatMap((item) => item.connector && !saved.includes(item.connector.id) && !existingIds.includes(item.connector.id) ? [item.connector] : [])

  const close = () => { if (!saving.current) onClose() }

  const submit = async () => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setFailures({})
    try {
      for (const connector of pending) {
        try {
          await onSave(connector)
          setSaved((current) => [...current, connector.id])
        } catch (reason) {
          setFailures((current) => ({ ...current, [connector.id]: reason instanceof Error ? reason.message : '保存失败，请重试' }))
        }
      }
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return <AddDialog title="通过 JSON 导入" description="粘贴 MCP 配置，支持单个连接器或多个 mcpServers 服务。" busy={busy} onClose={close} className="connector-json-add-dialog">
    <textarea aria-label="MCP JSON 配置" autoFocus disabled={busy} onChange={(event) => { setValue(event.target.value); setFailures({}) }} placeholder={'{\n  "mcpServers": {\n    "我的服务": { "type": "streamable-http", "url": "https://example.com/mcp" }\n  }\n}'} spellCheck={false} value={value} />
    {preview.error && <div className="kit-error" role="alert">{preview.error}</div>}
    <div aria-live="polite" className="connector-import-results">{preview.items.map((item, index) => {
      const id = item.connector?.id ?? ''
      const done = saved.includes(id)
      const error = item.error || failures[id] || (!done && existingIds.includes(id) ? '已存在，请在连接器详情中编辑，或使用其他名称 / ID' : '')
      return <article className={error ? 'error' : done ? 'saved' : ''} key={`${item.name}-${index}`}><strong>{item.name}</strong><span>{error || (done ? '已保存并启用' : `待导入 · ${item.connector?.transport}`)}</span></article>
    })}</div>
    <footer><button className="secondary" disabled={busy} onClick={close} type="button">{saved.length ? '完成' : '取消'}</button><button disabled={busy || !pending.length} onClick={() => void submit()} type="button">{busy ? '正在导入…' : `导入 ${pending.length} 个服务`}</button></footer>
  </AddDialog>
}
