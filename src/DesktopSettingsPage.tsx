import { Activity, BrainCircuit, Download, HardDrive, Keyboard, RefreshCw, SlidersHorizontal, UserRound } from 'lucide-react'
import { DesktopPreferencesPanel } from './DesktopPreferencesPanel'
import { AttachmentStoragePanel } from './AttachmentStoragePanel'
import { useState } from 'react'
import { DesktopUpdater } from './DesktopUpdater'
import { MemoryPage } from './MemoryPage'
import type { MemoryProfile } from './memory'
import { isUpdatableDesktop } from './updater'
import { buildRuntimeDiagnostics, runtimeDiagnosticsFilename } from './runtimeDiagnostics'
import type { HarnessProviderCheckResult } from './harness'
import type { HarnessHealth } from './useHarnessHealth'

interface DesktopSettingsPageProps {
  sessionToken: string
  employeeId: string
  memoryEndpoint: string
  memoryAvailable?: boolean
  displayName: string
  department: string
  position: string
  companyName: string
  onMemorySaved: (profile: MemoryProfile) => Promise<void> | void
  onOpenMemoryTask?: (id: string) => void
  harnessCapabilities?: Record<string, 'enabled' | 'gated' | 'unconfigured'>
  harnessHealth?: HarnessHealth
  harnessHealthDetail?: string
  harnessRuntime?: string
  harnessVersion?: string
  onCheckHarness?: () => Promise<void> | void
  onCheckModelProvider?: () => Promise<HarnessProviderCheckResult>
  allowShell?: boolean
  onAllowShellChange?: (value: boolean) => void
  allowLsp?: boolean
  onAllowLspChange?: (value: boolean) => void
  allowExternalAgents?: boolean
  onAllowExternalAgentsChange?: (value: boolean) => void
  allowHooks?: boolean
  onAllowHooksChange?: (value: boolean) => void
}

type SettingsSection = 'preferences' | 'profile' | 'shortcuts' | 'memory' | 'updates' | 'storage' | 'runtime'

export function DesktopSettingsPage({
  sessionToken,
  employeeId,
  memoryEndpoint,
  memoryAvailable = true,
  displayName,
  department,
  position,
  companyName,
  onMemorySaved,
  onOpenMemoryTask,
  harnessCapabilities = {},
  harnessHealth = 'idle',
  harnessHealthDetail = '本地执行环境将在任务开始时按需启动',
  harnessRuntime,
  harnessVersion,
  onCheckHarness,
  onCheckModelProvider,
  allowShell = true,
  onAllowShellChange = () => undefined,
  allowLsp = false,
  onAllowLspChange = () => undefined,
  allowExternalAgents = false,
  onAllowExternalAgentsChange = () => undefined,
  allowHooks = false,
  onAllowHooksChange = () => undefined,
}: DesktopSettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('preferences')
  const windowsDesktop = isUpdatableDesktop()
  const visibleSection = section === 'updates' && !windowsDesktop
    ? 'profile'
    : section === 'memory' && !memoryAvailable ? 'preferences' : section

  return <div className="desktop-settings">
    <aside className="settings-navigation" aria-label="桌面设置">
      <p>通用</p>
      <button className={section === 'preferences' ? 'active' : ''} onClick={() => setSection('preferences')} type="button"><SlidersHorizontal size={17} /><span><strong>偏好设置</strong><small>字号、宽度与动画</small></span></button>
      <button className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')} type="button">
        <UserRound size={17} /><span><strong>个人资料</strong><small>企业身份与账户信息</small></span>
      </button>
      <button className={section === 'shortcuts' ? 'active' : ''} onClick={() => setSection('shortcuts')} type="button">
        <Keyboard size={17} /><span><strong>快捷键</strong><small>常用桌面操作</small></span>
      </button>
      <button className={section === 'memory' ? 'active' : ''} disabled={!memoryAvailable} onClick={() => setSection('memory')} type="button">
        <BrainCircuit size={17} /><span><strong>记忆</strong><small>{memoryAvailable ? '工作方式与长期偏好' : '企业服务连接后可用'}</small></span>
      </button>
      <p>设备</p>
      <button className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')} type="button"><HardDrive size={17} /><span><strong>附件存储</strong><small>占用统计与未引用缓存清理</small></span></button>
      <button className={section === 'runtime' ? 'active' : ''} onClick={() => setSection('runtime')} type="button"><Activity size={17} /><span><strong>本地能力</strong><small>任务执行权限与诊断</small></span></button>
      {windowsDesktop && <button className={visibleSection === 'updates' ? 'active' : ''} onClick={() => setSection('updates')} type="button">
        <RefreshCw size={17} /><span><strong>更新应用</strong><small>检查桌面端新版本</small></span>
      </button>}
    </aside>
    <section className="settings-content">
      {visibleSection === 'preferences' ? <DesktopPreferencesPanel /> : visibleSection === 'storage' ? <AttachmentStoragePanel /> : visibleSection === 'runtime'
        ? <RuntimeCapabilitiesPanel capabilities={harnessCapabilities} health={harnessHealth} healthDetail={harnessHealthDetail} runtime={harnessRuntime} version={harnessVersion} onCheckHarness={onCheckHarness} onCheckModelProvider={onCheckModelProvider} allowShell={allowShell} onAllowShellChange={onAllowShellChange} allowLsp={allowLsp} onAllowLspChange={onAllowLspChange} allowExternalAgents={allowExternalAgents} onAllowExternalAgentsChange={onAllowExternalAgentsChange} allowHooks={allowHooks} onAllowHooksChange={onAllowHooksChange} /> : visibleSection === 'profile'
        ? <section className="profile-settings settings-panel"><header><span><UserRound size={18} /></span><div><h2>个人资料</h2><p>当前登录的企业账号信息。</p></div></header><dl><div><dt>姓名</dt><dd>{displayName}</dd></div><div><dt>员工账号</dt><dd>{employeeId}</dd></div><div><dt>部门</dt><dd>{department || '未设置'}</dd></div><div><dt>岗位</dt><dd>{position || '未设置'}</dd></div><div><dt>企业</dt><dd>{companyName}</dd></div></dl></section>
        : visibleSection === 'memory'
        ? <MemoryPage
            sessionToken={sessionToken}
            employeeId={employeeId}
            endpoint={memoryEndpoint}
            onSaved={onMemorySaved}
            onOpenTask={onOpenMemoryTask}
          />
        : visibleSection === 'shortcuts'
            ? <section className="shortcut-settings settings-panel"><header><span><Keyboard size={18} /></span><div><h2>键盘快捷键</h2><p>以下快捷键在小胤任意页面可用。</p></div></header><dl><div><dt>搜索任务</dt><dd><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd><small>macOS 使用 ⌘ K</small></dd></div><div><dt>发送消息</dt><dd><kbd>Enter</kbd><small>Shift + Enter 换行</small></dd></div><div><dt>关闭菜单或弹窗</dt><dd><kbd>Esc</kbd></dd></div><div><dt>拖入本地文件</dt><dd><span>直接拖到对话</span><small>自动授权文件所在目录</small></dd></div></dl></section>
            : <section className="update-settings"><header><h2>更新应用</h2></header><DesktopUpdater variant="settings" /></section>}
    </section>
  </div>
}

function RuntimeCapabilitiesPanel({ capabilities, health, healthDetail, runtime, version, onCheckHarness, onCheckModelProvider, allowShell, onAllowShellChange, allowLsp, onAllowLspChange, allowExternalAgents, onAllowExternalAgentsChange, allowHooks, onAllowHooksChange }: { capabilities: Record<string, 'enabled' | 'gated' | 'unconfigured'>; health: HarnessHealth; healthDetail: string; runtime?: string; version?: string; onCheckHarness?: () => Promise<void> | void; onCheckModelProvider?: () => Promise<HarnessProviderCheckResult>; allowShell: boolean; onAllowShellChange: (value: boolean) => void; allowLsp: boolean; onAllowLspChange: (value: boolean) => void; allowExternalAgents: boolean; onAllowExternalAgentsChange: (value: boolean) => void; allowHooks: boolean; onAllowHooksChange: (value: boolean) => void }) {
  const [providerCheck, setProviderCheck] = useState<HarnessProviderCheckResult>()
  const [providerChecking, setProviderChecking] = useState(false)
  const configured = (keys: string[]) => keys.some((key) => capabilities[key] && capabilities[key] !== 'unconfigured')
  const counts = Object.values(capabilities).reduce((result, status) => ({ ...result, [status]: result[status] + 1 }), { enabled: 0, gated: 0, unconfigured: 0 })
  const unchecked = health === 'idle'
  const exportDiagnostics = () => {
    const payload = buildRuntimeDiagnostics({ runtime, version, capabilities })
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = runtimeDiagnosticsFilename()
    link.click()
    URL.revokeObjectURL(url)
  }
  return <section className="settings-panel runtime-settings"><header><span><Activity size={18} /></span><div><h2>本地能力</h2><p>管理任务在这台电脑上的执行权限。</p></div></header>
    <div className={`local-runtime-status ${unchecked ? 'unchecked' : health}`}><span className={`runtime-dot ${health === 'degraded' ? 'unconfigured' : health === 'checking' ? 'gated' : unchecked ? 'unchecked' : 'enabled'}`} /><span><strong>{health === 'checking' ? '正在检查' : health === 'degraded' ? '需要处理' : unchecked ? '按需启动' : '本地执行环境可用'}</strong><small>{healthDetail}</small></span></div>
    <div className="runtime-control-list">
      <label className="runtime-tools-mode"><span><strong>允许本地命令执行</strong><small>任务可以运行 Bash、PowerShell 和持续终端；高风险操作仍需确认。</small></span><input aria-label="允许本地命令执行" checked={allowShell} onChange={(event) => onAllowShellChange(event.target.checked)} role="switch" type="checkbox" /></label>
    </div>
    <details className="runtime-advanced">
      <summary>高级设置与诊断</summary>
      <div className="runtime-control-list">
        {configured(['lsp']) && <label className="runtime-tools-mode"><span><strong>代码语言服务</strong><small>使用管理员已配置的语言服务辅助代码理解。</small></span><input aria-label="启用代码语言服务" checked={allowLsp} onChange={(event) => onAllowLspChange(event.target.checked)} role="switch" type="checkbox" /></label>}
        {configured(['codexSubagent', 'claudeSubagent', 'acpSubagent', 'dshSubagent']) && <label className="runtime-tools-mode"><span><strong>外部协作 Agent</strong><small>允许调用管理员已配置的外部开发 Agent，可能启动本机进程。</small></span><input aria-label="启用外部协作 Agent" checked={allowExternalAgents} onChange={(event) => onAllowExternalAgentsChange(event.target.checked)} role="switch" type="checkbox" /></label>}
        {configured(['codexHooks', 'claudeHooks']) && <label className="runtime-tools-mode"><span><strong>自动化 Hooks</strong><small>允许管理员已配置的 Hooks 在任务期间执行本机命令。</small></span><input aria-label="启用自动化 Hooks" checked={allowHooks} onChange={(event) => onAllowHooksChange(event.target.checked)} role="switch" type="checkbox" /></label>}
      </div>
      <div className="runtime-diagnostics">
        <dl><div><dt>执行引擎</dt><dd>{runtime ? `DeepSeek Harness ${version ?? ''}`.trim() : '尚未检查'}</dd></div>{Object.keys(capabilities).length > 0 && <div><dt>能力状态</dt><dd>{counts.enabled} 项可用 · {counts.gated} 项受控 · {counts.unconfigured} 项未配置</dd></div>}</dl>
        <p>诊断文件只包含版本和能力状态，不包含会话、文件内容或凭据。</p>
        <div className="runtime-diagnostics-actions">
          <button disabled={health === 'checking' || !onCheckHarness} onClick={() => void onCheckHarness?.()} type="button"><RefreshCw size={14} />{health === 'checking' ? '检查中' : '检查本地能力'}</button>
          <button disabled={providerChecking || !onCheckModelProvider} onClick={async () => { if (!onCheckModelProvider) return; setProviderChecking(true); setProviderCheck(undefined); try { setProviderCheck(await onCheckModelProvider()) } catch (reason) { setProviderCheck({ status: 'unreachable', latencyMs: 0, detail: reason instanceof Error ? reason.message : '检查失败，请重试' }) } finally { setProviderChecking(false) } }} type="button"><RefreshCw size={14} />{providerChecking ? '检查中' : '检查模型服务'}</button>
          <button onClick={exportDiagnostics} type="button"><Download size={14} />导出诊断</button>
        </div>
        {providerCheck && <p className={`runtime-provider-check ${providerCheck.status}`} role="status">模型服务：{providerCheck.detail}{providerCheck.latencyMs > 0 ? ` · ${providerCheck.latencyMs}ms` : ''}</p>}
      </div>
    </details>
  </section>
}
