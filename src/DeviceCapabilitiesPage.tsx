import { Activity, CheckCircle2, Monitor, RefreshCw, Server, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { loadDeviceCapabilityReports, submitDeviceCapabilityReport } from './api'
import { buildDeviceCapabilityReport, inspectDeviceCapabilities } from './deviceCapabilities'
import type { ConnectorCatalogEntry, DeviceCapabilityReport, DeviceCapabilityStatus, RuntimeStatus } from './types'

interface DeviceCapabilitiesPageProps {
  endpoint: string
  employeeId: string
  accessToken: string
  connectors: ConnectorCatalogEntry[]
  authorizedDirectoryCount: number
  runtimeStatus: RuntimeStatus
}

export function DeviceCapabilitiesPage({
  endpoint, employeeId, accessToken, connectors, authorizedDirectoryCount, runtimeStatus,
}: DeviceCapabilitiesPageProps) {
  const [reports, setReports] = useState<DeviceCapabilityReport[]>([])
  const [loading, setLoading] = useState(true)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    loadDeviceCapabilityReports(endpoint, employeeId, accessToken, controller.signal)
      .then(setReports)
      .catch((value) => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [accessToken, employeeId, endpoint])

  const latest = reports[0]
  const counts = useMemo(() => latest?.capabilities.reduce((values, capability) => {
    values[capability.status] += 1
    return values
  }, { READY: 0, DEGRADED: 0, UNSUPPORTED: 0 } as Record<DeviceCapabilityStatus, number>), [latest])

  const runProbe = async () => {
    if (probing) return
    setProbing(true)
    setError('')
    try {
      const probe = await inspectDeviceCapabilities()
      const request = buildDeviceCapabilityReport(probe, { connectors, authorizedDirectoryCount, runtimeStatus })
      const report = await submitDeviceCapabilityReport(endpoint, employeeId, accessToken, request)
      setReports((current) => [report, ...current].slice(0, 50))
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
    } finally {
      setProbing(false)
    }
  }

  return <div className="device-capability-page">
    <section className="device-probe-hero">
      <div><span><Activity size={15} />设备预检</span><h2>{latest ? overallLabel(latest) : '尚未生成验收记录'}</h2>
        <p>自动检测本机运行时、文件、Office、Shell、Computer Use、控制中心和企业连接器状态。</p></div>
      <button disabled={probing} onClick={() => void runProbe()} type="button"><RefreshCw className={probing ? 'spin' : ''} size={15} />{probing ? '正在检测…' : '检测并上报'}</button>
    </section>
    <div className="device-privacy-note"><ShieldCheck size={15} /><span><strong>仅上传去敏状态</strong><small>不会上传主机名、用户名、文件路径、截图、Token、Shell 输出或业务数据。</small></span></div>
    {error && <div className="device-error">{error}</div>}
    {loading && <div className="kit-empty">正在读取设备验收记录…</div>}
    {!loading && latest && <>
      <section className="device-summary-grid">
        <article><CheckCircle2 size={18} /><span><strong>{counts?.READY ?? 0}</strong><small>能力已就绪</small></span></article>
        <article><TriangleAlert size={18} /><span><strong>{counts?.DEGRADED ?? 0}</strong><small>需要处理</small></span></article>
        <article><Monitor size={18} /><span><strong>{latest.displayCount}</strong><small>显示器 · {latest.displayScalePercents.join('% / ')}%</small></span></article>
        <article><Server size={18} /><span><strong>v{latest.desktopVersion}</strong><small>{platformLabel(latest.platform)} · {latest.architecture}</small></span></article>
      </section>
      <section className="device-capability-list"><header><strong>最新能力状态</strong><small>{formatTime(latest.createdAt)} · 设备 {latest.deviceId.slice(0, 8)}</small></header>
        {latest.capabilities.map((capability) => <article key={capability.key}><i className={capability.status.toLowerCase()} /><span><strong>{capabilityLabel(capability.key, connectors)}</strong><small>{capability.detail}</small></span><em className={capability.status.toLowerCase()}>{statusLabel(capability.status)}</em></article>)}
      </section>
      <section className="device-report-history"><header><strong>最近验收记录</strong><small>控制中心保留当前员工最近 50 条</small></header>
        {reports.slice(0, 10).map((report) => <article key={report.id}><span>{formatTime(report.createdAt)}</span><small>v{report.desktopVersion} · {platformLabel(report.platform)} · {report.displayCount} 屏</small><em>{overallLabel(report)}</em></article>)}
      </section>
    </>}
  </div>
}

function overallLabel(report: DeviceCapabilityReport): string {
  return report.capabilities.some(({ status }) => status === 'DEGRADED') ? '设备存在待处理能力' : '设备能力已就绪'
}

function statusLabel(status: DeviceCapabilityStatus): string {
  return ({ READY: '已就绪', DEGRADED: '待处理', UNSUPPORTED: '不适用' })[status]
}

function platformLabel(platform: string): string {
  return ({ windows: 'Windows', macos: 'macOS', linux: 'Linux', browser: '浏览器开发' } as Record<string, string>)[platform] ?? platform
}

function capabilityLabel(key: string, connectors: ConnectorCatalogEntry[]): string {
  const fixed: Record<string, string> = {
    'desktop.runtime': '小胤桌面运行时', 'local.files': '本地文件', 'office.documents': 'DOCX / XLSX / PDF',
    'local.shell': '受审批 Shell', 'computer.use': 'Windows Computer Use', 'control.plane': '公司控制中心',
  }
  if (fixed[key]) return fixed[key]
  if (key.startsWith('connector.')) {
    const id = key.slice('connector.'.length)
    return connectors.find((connector) => connector.id === id)?.name ?? `企业连接器 ${id}`
  }
  return key
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
