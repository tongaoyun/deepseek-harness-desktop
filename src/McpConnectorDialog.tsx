import { useRef, useState } from 'react'
import { AddDialog } from './AddDialog'
import { parseConnectorJson } from './connectorImport'
import type { ConnectorCatalogEntry } from './types'

export function splitMcpCommand(value: string): string[] {
  const result: string[] = []; let token = '', quote = '', started = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\' && quote !== "'" && (value[i + 1] === '"' || value[i + 1] === "'" || value[i + 1] === '\\' || /\s/.test(value[i + 1] ?? ''))) { token += value[++i]; started = true }
    else if (quote) { if (c === quote) quote = ''; else token += c }
    else if (c === '"' || c === "'") { quote = c; started = true }
    else if (/\s/.test(c)) { if (started) { result.push(token); token = ''; started = false } }
    else { token += c; started = true }
  }
  if (quote) throw new Error('命令中的引号未闭合')
  if (started) result.push(token)
  if (!result[0]) throw new Error('请填写启动命令')
  return result
}

export function McpConnectorDialog({ initial, existingIds, onSave, onClose }: { initial?: ConnectorCatalogEntry; existingIds: string[]; onSave: (value: ConnectorCatalogEntry) => Promise<void>; onClose: () => void }) {
  const [transport, setTransport] = useState(initial?.transport ?? 'stdio')
  const [name, setName] = useState(initial?.name ?? '')
  const [command, setCommand] = useState(initial ? [initial.command, ...initial.arguments ?? []].filter((v) => v !== undefined).map((v) => JSON.stringify(v)).join(' ') : '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [authMode, setAuthMode] = useState(initial?.authMode ?? 'none')
  const [timeoutSeconds, setTimeoutSeconds] = useState(initial?.timeoutSeconds ?? 60)
  const [env, setEnv] = useState(Object.entries(initial?.environment ?? {}).length ? Object.entries(initial!.environment!) : [['', '']])
  const [headers, setHeaders] = useState(Object.entries(initial?.headers ?? {}).length ? Object.entries(initial!.headers!) : [['', '']])
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false)
  const rows = transport === 'stdio' ? env : headers
  const setRows = transport === 'stdio' ? setEnv : setHeaders
  const record = (rows: string[][]) => {
    const entries = rows.filter(([key, value]) => key.trim() || value)
    if (entries.some(([key]) => !key.trim())) throw new Error('请填写变量名称')
    if (new Set(entries.map(([key]) => key.trim())).size !== entries.length) throw new Error('变量名称不能重复')
    return Object.fromEntries(entries.map(([key, value]) => [key.trim(), value]))
  }
  return <AddDialog title={initial ? '编辑 MCP 服务器' : '添加 MCP 服务器'} description="配置 MCP 服务，连接后即可在任务中使用。" busy={busy} onClose={onClose}><form onSubmit={async (event) => {
    event.preventDefault(); if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const parts = transport === 'stdio' ? splitMcpCommand(command) : []
      const parsed = parseConnectorJson(JSON.stringify({ id: initial?.id, name, transport, authMode: transport === 'stdio' ? 'none' : authMode, command: parts[0], args: parts.slice(1), url, env: transport === 'stdio' ? record(env) : {}, headers: transport === 'stdio' ? {} : record(headers) }))
      if (!initial && existingIds.includes(parsed.id)) throw new Error('该连接器已存在，请使用其他名称或编辑已有配置')
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('超时时间须为 1–600 秒')
      await onSave({ ...initial, ...parsed, timeoutSeconds, version: initial?.version ?? parsed.version, toolNames: initial?.toolNames ?? [], readOnlyTools: initial?.readOnlyTools ?? [] })
      onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }}><fieldset disabled={busy}>
    <label>服务器类型<select value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}><option value="stdio">STDIO</option><option value="streamable-http">Streamable HTTP</option></select></label>
    <label>服务器名称<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="my-mcp-server" /></label>
    {transport !== 'stdio' && <label>认证方式<select value={authMode} onChange={(e) => setAuthMode(e.target.value as typeof authMode)}><option value="none">无 / 自定义请求头</option><option value="oauth">浏览器账户授权（OAuth）</option><option value="employee-bearer">员工 Bearer Token</option><option value="erp-cookie">ERP 扫码会话</option></select></label>}
    {transport === 'stdio' ? <label>命令<textarea required rows={3} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem" /><small>粘贴完整命令；带空格的路径请用引号包围，不通过 Shell 执行。</small></label> : <label>服务器地址<input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></label>}
    <div className="add-variable-list"><strong>{transport === 'stdio' ? '环境变量' : '请求头'} <small>（可选）</small></strong>{rows.map(([key, value], index) => <div key={index}><input aria-label={`变量名 ${index + 1}`} value={key} placeholder={transport === 'stdio' ? 'API_KEY' : 'Authorization'} onChange={(e) => setRows(rows.map((r, n) => n === index ? [e.target.value, value] : r))} /><input aria-label={`变量值 ${index + 1}`} type="password" value={value} placeholder="值" onChange={(e) => setRows(rows.map((r, n) => n === index ? [key, e.target.value] : r))} /><button type="button" aria-label={`移除变量 ${index + 1}`} onClick={() => setRows(rows.filter((_, n) => n !== index))}>×</button></div>)}<button type="button" onClick={() => setRows([...rows, ['', '']])}>＋ 添加变量</button></div>
    <label>执行超时（秒）<input type="number" min={1} max={600} step={1} required value={timeoutSeconds || ''} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} /><small>默认 60 秒，支持 1–600 秒，适用于任务中的连接、工具列表获取和调用。</small></label>
  </fieldset>{error && <p className="add-error" role="alert">{error}</p>}<footer><button type="submit" disabled={busy}>{busy ? '正在保存…' : initial ? '保存' : '添加'}</button></footer></form></AddDialog>
}
