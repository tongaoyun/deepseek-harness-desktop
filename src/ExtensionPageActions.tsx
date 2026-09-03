import { Braces, FileUp, PenLine, Plus, RefreshCw, Search, Send, WandSparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { connectorCategories, type ConnectorCategory } from './extensionCategories'
import type { ConnectorCatalogEntry, ConnectorTransport } from './types'

type PageKind = 'experts' | 'skills' | 'connectors'

interface Props {
  page: PageKind
  loading: boolean
  query: string
  onQuery: (value: string) => void
  onRefresh: () => void
  onCreate: () => void
  onUpload: () => void
  onImportConnector: (connector: ConnectorCatalogEntry) => void
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

  useEffect(() => { setOpen(false) }, [props.page])

  const noun = props.page === 'experts' ? '专家套件' : props.page === 'skills' ? '技能' : '连接器'
  return <>
    <div className="capability-page-actions" ref={root}>
      <button aria-label="刷新目录" className="refresh-extension-button" disabled={props.loading} onClick={props.onRefresh} title="刷新目录" type="button"><RefreshCw className={props.loading ? 'spin' : ''} size={17} /></button>
      <label className="capability-page-search"><Search size={16} /><input aria-label={`搜索${noun}`} onChange={(event) => props.onQuery(event.target.value)} placeholder={`搜索${props.page === 'experts' ? '套件' : noun}…`} value={props.query} />{props.query && <button aria-label="清空搜索" onClick={() => props.onQuery('')} type="button"><X size={13} /></button>}</label>
      <button aria-expanded={open} className="add-extension-button" onClick={() => setOpen((value) => !value)} type="button"><Plus size={17} />添加</button>
      {open && <div className="extension-add-menu" role="menu">
        {props.page !== 'connectors' && <button onClick={() => { setOpen(false); props.onCreate() }} role="menuitem" type="button"><WandSparkles size={18} /><span><strong>通过小胤创建</strong><small>创建个性化{noun}，保存在本机使用</small></span></button>}
        {props.page === 'connectors'
          ? <>
            <button onClick={() => { setOpen(false); props.onCreate() }} role="menuitem" type="button"><PenLine size={18} /><span><strong>手动填写配置</strong><small>填写任意 MCP 服务的连接信息</small></span></button>
            <button onClick={() => { setOpen(false); setJsonOpen(true) }} role="menuitem" type="button"><Braces size={18} /><span><strong>粘贴 JSON 配置</strong><small>兼容常见 MCP JSON 配置</small></span></button>
          </>
          : <button disabled={props.loading} onClick={() => { setOpen(false); props.onUpload() }} role="menuitem" type="button"><FileUp size={18} /><span><strong>上传{noun}</strong><small>导入 ZIP 或 tar.gz，仅安装到本机</small></span></button>}
        <button disabled role="menuitem" type="button"><Send size={18} /><span><strong>提交到企业市场</strong><small>创建后可在创作中心提交管理员审核</small></span></button>
      </div>}
    </div>
    {jsonOpen && <ConnectorJsonModal onClose={() => setJsonOpen(false)} onSave={(connector) => { props.onImportConnector(connector); setJsonOpen(false) }} />}
  </>
}

function ConnectorJsonModal({ onClose, onSave }: { onClose: () => void; onSave: (connector: ConnectorCatalogEntry) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  const submit = () => {
    try {
      onSave(parseConnectorJson(value))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'JSON 配置无效')
    }
  }

  return <div className="expert-modal-backdrop" onMouseDown={onClose} role="presentation"><section aria-modal="true" className="expert-kit-modal connector-json-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
    <button aria-label="关闭" className="expert-modal-close" onClick={onClose} type="button"><X size={17} /></button>
    <header><span><Braces size={21} /></span><div><h2>粘贴 JSON 配置</h2><p>支持单个连接器对象，或包含一个服务的 mcpServers 配置。密钥只保存在本机。</p></div></header>
    <textarea autoFocus onChange={(event) => setValue(event.target.value)} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["..."] }\n  }\n}'} spellCheck={false} value={value} />
    {error && <div className="kit-error">{error}</div>}
    <footer><button className="secondary" onClick={onClose} type="button">取消</button><button disabled={!value.trim()} onClick={submit} type="button">保存到本机</button></footer>
  </section></div>
}

export function parseConnectorJson(value: string): ConnectorCatalogEntry {
  const parsed = JSON.parse(value) as Record<string, unknown>
  const source = parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? Object.entries(parsed.mcpServers as Record<string, unknown>)[0]
    : undefined
  const id = source?.[0] ?? String(parsed.id ?? '').trim()
  const config = (source?.[1] ?? parsed) as Record<string, unknown>
  if (!id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error('请提供 2–64 位小写字母、数字或连字符组成的连接器 ID')
  const transport = normalizeTransport(config.transport, config.command, config.url)
  const categoryValue = String(parsed.category ?? 'other')
  const category = (connectorCategories.some((item) => item.id === categoryValue) ? categoryValue : 'other') as ConnectorCategory
  const argumentValue = config.args ?? config.arguments
  const connector: ConnectorCatalogEntry = {
    id,
    name: String(parsed.name ?? id),
    summary: String(parsed.summary ?? `个人 MCP 连接器 · ${id}`),
    category,
    kind: 'personal-mcp',
    scope: 'employee',
    status: 'ready',
    managed: false,
    version: String(parsed.version ?? '1.0.0'),
    transport,
    url: String(config.url ?? ''),
    authMode: 'none',
    command: config.command ? String(config.command) : undefined,
    arguments: Array.isArray(argumentValue) ? argumentValue.map(String) : [],
    environment: recordOfStrings(config.env ?? config.environment),
    headers: recordOfStrings(config.headers),
    toolNames: Array.isArray(parsed.toolNames) ? parsed.toolNames.map(String) : [],
  }
  if (transport === 'stdio' && !connector.command) throw new Error('stdio 连接器必须包含 command')
  if (transport !== 'stdio' && !connector.url) throw new Error('HTTP/SSE 连接器必须包含 url')
  return connector
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? '')]))
}

function normalizeTransport(value: unknown, command: unknown, url: unknown): ConnectorTransport {
  if (value === 'sse' || value === 'streamable-http' || value === 'stdio') return value
  if (value === 'http') return 'streamable-http'
  if (command) return 'stdio'
  if (url) return 'streamable-http'
  return 'stdio'
}
