import { Activity, CheckCircle2, Clock3, Laptop, Monitor, RefreshCw, Search, Server, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { loadDeviceCapabilityReports, loadDeviceFleetOverview, submitDeviceCapabilityReport } from './api'
import { buildDeviceCapabilityReport, inspectDeviceCapabilities } from './deviceCapabilities'
import type { ConnectorCatalogEntry, DeviceCapabilityReport, DeviceCapabilityStatus, DeviceFleetOverview, DeviceFleetStatus, RuntimeStatus } from './types'

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
  const [fleet, setFleet] = useState<DeviceFleetOverview>()
  const [fleetLoading, setFleetLoading] = useState(true)
  const [fleetQuery, setFleetQuery] = useState('')
  const [fleetStatus, setFleetStatus] = useState<'' | DeviceFleetStatus>('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    loadDeviceCapabilityReports(endpoint, employeeId, accessToken, controller.signal)
      .then(setReports)
      .catch((value) => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [accessToken, employeeId, endpoint])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setFleetLoading(true)
      loadDeviceFleetOverview(endpoint, employeeId, accessToken, fleetQuery, fleetStatus, controller.signal)
        .then(setFleet)
        .catch((value) => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)) })
        .finally(() => { if (!controller.signal.aborted) setFleetLoading(false) })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [accessToken, employeeId, endpoint, fleetQuery, fleetStatus, reports])

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
    <section className="device-fleet">
      <header><div><span><Users size={15} />组织设备</span><h2>团队设备健康度</h2><p>每位员工、每台设备只展示最近一次去敏上报。</p></div>
        <label><Search size={14} /><input aria-label="搜索团队设备" onChange={(event) => setFleetQuery(event.target.value)} placeholder="员工、设备、版本或平台" value={fleetQuery} /></label></header>
      {fleet && <div className="device-fleet-summary">
        <article><Laptop size={17} /><strong>{fleet.totalDevices}</strong><small>设备总数</small></article>
        <article><CheckCircle2 size={17} /><strong>{fleet.readyDevices}</strong><small>状态正常</small></article>
        <article><ShieldCheck size={17} /><strong>{fleet.nonCompliantDevices}</strong><small>不符合基线</small></article>
        <article><TriangleAlert size={17} /><strong>{fleet.degradedDevices}</strong><small>需要处理</small></article>
        <article><Clock3 size={17} /><strong>{fleet.staleDevices}</strong><small>超过 {fleet.policy.staleAfterDays} 天</small></article>
      </div>}
      {fleet && <div className="device-policy-bar"><ShieldCheck size={15} /><span><strong>公司设备基线</strong><small>最低桌面版本 v{fleet.policy.minimumDesktopVersion} · {fleet.policy.requiredCapabilities.length} 项必需能力 · {fleet.policy.staleAfterDays} 天未上报视为过期</small></span><em>{fleet.policy.requiredCapabilities.map((key) => capabilityLabel(key, connectors)).join('、') || '未设置必需能力'}</em></div>}
      <div className="device-fleet-filters">
        {(['', 'READY', 'NON_COMPLIANT', 'DEGRADED', 'STALE'] as const).map((value) => <button className={fleetStatus === value ? 'active' : ''} key={value || 'all'} onClick={() => setFleetStatus(value)} type="button">{fleetFilterLabel(value)}</button>)}
      </div>
      {fleetLoading && <div className="kit-empty">正在汇总团队设备…</div>}
      {!fleetLoading && fleet?.devices.length === 0 && <div className="kit-empty">没有符合条件的设备。</div>}
      {!fleetLoading && fleet && fleet.devices.length > 0 && <div className="device-fleet-table">
        <div className="device-fleet-row heading"><span>员工与设备</span><span>环境</span><span>整改原因</span><span>最近上报</span><span>状态</span></div>
        {fleet.devices.map((device) => <div className="device-fleet-row" key={`${device.employeeId}:${device.deviceId}`}>
          <span><strong>{device.employeeId}</strong><small>{device.deviceId.slice(0, 8)}</small></span>
          <span><strong>v{device.desktopVersion} · {platformLabel(device.platform)}</strong><small>{device.architecture} · {device.displayCount} 屏 · {device.displayScalePercents.join('% / ')}%</small></span>
          <span><strong>{device.complianceIssues.length + device.degradedCapabilities.length || '—'}</strong><small>{deviceIssueText(device, connectors)}</small></span>
          <span><strong>{formatTime(device.reportedAt)}</strong><small>{relativeReportAge(device.reportedAt)}</small></span>
          <em className={device.status.toLowerCase()}>{fleetStatusLabel(device.status)}</em>
        </div>)}
      </div>}
    </section>
  </div>
}

function overallLabel(report: DeviceCapabilityReport): string {
  return report.capabilities.some(({ status }) => status === 'DEGRADED') ? '设备存在待处理能力' : '设备能力已就绪'
}

function statusLabel(status: DeviceCapabilityStatus): string {
  return ({ READY: '已就绪', DEGRADED: '待处理', UNSUPPORTED: '不适用' })[status]
}

function fleetFilterLabel(status: '' | DeviceFleetStatus): string {
  return status ? fleetStatusLabel(status) : '全部设备'
}

function fleetStatusLabel(status: DeviceFleetStatus): string {
  return ({ READY: '正常', DEGRADED: '待处理', NON_COMPLIANT: '不合规', STALE: '长期未上报' })[status]
}

function deviceIssueText(device: DeviceFleetOverview['devices'][number], connectors: ConnectorCatalogEntry[]): string {
  const compliance = device.complianceIssues.map(({ detail }) => detail)
  const degraded = device.degradedCapabilities.map((key) => capabilityLabel(key, connectors))
  return [...compliance, ...degraded].join('、') || '无'
}

function relativeReportAge(value: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000))
  if (days === 0) return '今天上报'
  return `${days} 天前上报`
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
