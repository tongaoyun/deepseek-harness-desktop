import { Activity, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { diagnoseConnectors } from './harness'
import type {
  ConnectorCatalogEntry,
  ConnectorDiagnosticResult,
  ConnectorRuntimeDefinition,
} from './types'

interface ConnectorsPageProps {
  accessToken: string
  catalog: ConnectorCatalogEntry[]
  runtime: ConnectorRuntimeDefinition[]
  loading: boolean
  catalogError: string
  syncError: string
}

export function ConnectorsPage({
  accessToken, catalog, runtime, loading, catalogError, syncError,
}: ConnectorsPageProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<Map<string, ConnectorDiagnosticResult>>(new Map())
  const [checkedAt, setCheckedAt] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'enterprise' | 'connected' | 'builtin'>('enterprise')
  const [statusFilter, setStatusFilter] = useState<'all' | ConnectorCatalogEntry['status']>('all')
  const targets = useMemo(
    () => runtime.filter((connector) => connector.status === 'ready' && connector.transport !== 'desktop'),
    [runtime],
  )
  const catalogFingerprint = catalog
    .map((connector) => `${connector.id}:${connector.version}:${connector.status}:${connector.transport}:${connector.url}:${connector.toolNames.join(',')}`)
    .join('|')
  const visibleCatalog = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return catalog.filter((connector) => {
      const builtIn = (connector.transport ?? connector.kind) === 'desktop' || connector.kind === 'desktop-builtin'
      const matchesView = view === 'builtin' ? builtIn : view === 'connected' ? connector.status === 'ready' : !builtIn
      return matchesView
        && (statusFilter === 'all' || connector.status === statusFilter)
        && (!needle || `${connector.name} ${connector.summary} ${connector.id} ${connector.toolNames.join(' ')}`.toLocaleLowerCase('zh-CN').includes(needle))
    })
  }, [catalog, query, statusFilter, view])

  useEffect(() => {
    setResults(new Map())
    setCheckedAt('')
    setError('')
  }, [catalogFingerprint])

  async function runDiagnostics() {
    if (busy || targets.length === 0) return
    setBusy(true)
    setError('')
    try {
      const diagnostics = await diagnoseConnectors({ connectors: targets, accessToken })
      setResults(new Map(diagnostics.map((result) => [result.id, result])))
      setCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    } catch (diagnosticError) {
      setResults(new Map())
      setError(diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError))
    } finally {
      setBusy(false)
    }
  }

  return <>
    <div className="connector-market-tabs" role="tablist" aria-label="连接器分类">
      <button aria-selected={view === 'enterprise'} className={view === 'enterprise' ? 'active' : ''} onClick={() => setView('enterprise')} role="tab" type="button">企业连接器</button>
      <button aria-selected={view === 'connected'} className={view === 'connected' ? 'active' : ''} onClick={() => setView('connected')} role="tab" type="button">已连接</button>
      <button aria-selected={view === 'builtin'} className={view === 'builtin' ? 'active' : ''} onClick={() => setView('builtin')} role="tab" type="button">桌面内置</button>
    </div>
    <div className="connector-diagnostics-toolbar">
      <span><Activity size={14} /><strong>运行时诊断</strong><small>执行 MCP 握手与工具发现，不调用模型或业务工具</small></span>
      {checkedAt && <em>最近检测 {checkedAt}</em>}
      <button disabled={busy || targets.length === 0} onClick={() => void runDiagnostics()} type="button">
        <RefreshCw className={busy ? 'spin' : ''} size={13} />{busy ? '正在检测…' : '实时检测'}
      </button>
    </div>
    <div className="extension-toolbar connector-filter-toolbar">
      <label><Search size={14} /><input aria-label="搜索连接器" onChange={(event) => setQuery(event.target.value)} placeholder="搜索连接器或工具" value={query} />{query && <button aria-label="清空搜索" onClick={() => setQuery('')} type="button"><X size={12} /></button>}</label>
      <div>{([
        ['all', '全部'], ['ready', '已就绪'], ['needs-configuration', '需要配置'], ['unavailable', '不可用'], ['disabled', '已停用'],
      ] as const).map(([id, label]) => <button className={statusFilter === id ? 'active' : ''} key={id} onClick={() => setStatusFilter(id)} type="button">{label}</button>)}</div>
    </div>
    {loading && <div className="kit-empty">正在同步企业连接器…</div>}
    {!loading && catalog.length === 0 && <div className="kit-empty">控制中心尚未配置连接器</div>}
    {!loading && catalog.length > 0 && visibleCatalog.length === 0 && <div className="kit-empty">没有匹配的连接器</div>}
    {catalogError && <div className="kit-error">{catalogError}</div>}
    {syncError && <div className="kit-error">{syncError}</div>}
    {error && <div className="kit-error">{error}</div>}
    <div className="kit-grid">{visibleCatalog.map((connector) => {
      const diagnostic = results.get(connector.id)
      return <article key={connector.id}>
        <div className="kit-card-head"><span className={`connector-state ${connector.status}`}>{connectorStatusLabel(connector.status)}</span><small>{connector.managed ? '公司托管' : '员工配置'}</small></div>
        <h3>{connector.name}</h3>
        <p>{connector.summary}</p>
        <div className="kit-capabilities">
          <small>{connector.transport ?? connector.kind}</small><small>v{connector.version ?? '1'}</small><small>{connector.scope}</small><small>{connector.toolNames.length} 个登记工具</small>
        </div>
        {connector.toolNames.length > 0 && <div className="connector-tools">{connector.toolNames.join(' · ')}</div>}
        {diagnostic && <ConnectorDiagnostic result={diagnostic} />}
        {!diagnostic && checkedAt && connector.status === 'ready' && (connector.transport ?? connector.kind) === 'desktop'
          && <div className="connector-diagnostic ready">桌面内置能力，无需远程握手</div>}
        {!diagnostic && connector.status !== 'ready'
          && <div className="connector-diagnostic skipped">静态状态未就绪，未发起远程连接</div>}
        <small className="connector-activation-note">{connector.status === 'ready' ? '已加入新任务的能力快照' : '启用后将加入新任务，不影响进行中的任务'}</small>
      </article>
    })}</div>
  </>
}

function ConnectorDiagnostic({ result }: { result: ConnectorDiagnosticResult }) {
  if (result.status === 'unavailable') {
    return <div className="connector-diagnostic unavailable"><strong>握手失败 · {result.latencyMs}ms</strong><small>{result.error ?? '连接器不可用'}</small></div>
  }
  if (result.status === 'drift') {
    return <div className="connector-diagnostic drift">
      <strong>工具清单不一致 · {result.latencyMs}ms</strong>
      {result.missingTools.length > 0 && <small>服务缺少：{result.missingTools.join(' · ')}</small>}
      {result.undeclaredTools.length > 0 && <small>未登记：{result.undeclaredTools.join(' · ')}</small>}
    </div>
  }
  return <div className="connector-diagnostic ready"><strong>握手正常 · {result.latencyMs}ms</strong><small>发现 {result.discoveredTools.length} 个工具，与登记清单一致</small></div>
}

function connectorStatusLabel(status: ConnectorCatalogEntry['status']): string {
  return ({
    ready: '已就绪',
    'needs-configuration': '需要配置',
    unavailable: '暂不可用',
    disabled: '已停用',
  })[status]
}
