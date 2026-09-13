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
import type { HarnessToolsMode } from './runtimePreferences'

interface DesktopSettingsPageProps {
  accessToken: string
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
  harnessRuntime?: string
  harnessVersion?: string
  onCheckModelProvider?: () => Promise<HarnessProviderCheckResult>
  toolsMode?: HarnessToolsMode
  onToolsModeChange?: (value: HarnessToolsMode) => void
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
  accessToken,
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
  harnessRuntime,
  harnessVersion,
  onCheckModelProvider,
  toolsMode = 'native',
  onToolsModeChange = () => undefined,
  allowShell = true,
  onAllowShellChange = () => undefined,
  allowLsp = true,
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
      {windowsDesktop && <button className={visibleSection === 'updates' ? 'active' : ''} onClick={() => setSection('updates')} type="button">
        <RefreshCw size={17} /><span><strong>更新应用</strong><small>检查桌面端新版本</small></span>
      </button>}
      <button className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')} type="button"><HardDrive size={17} /><span><strong>附件存储</strong><small>占用统计与未引用缓存清理</small></span></button>
      <button className={section === 'runtime' ? 'active' : ''} onClick={() => setSection('runtime')} type="button"><Activity size={17} /><span><strong>运行时能力</strong><small>Harness 底层能力状态</small></span></button>
    </aside>
    <section className="settings-content">
      {visibleSection === 'preferences' ? <DesktopPreferencesPanel /> : visibleSection === 'storage' ? <AttachmentStoragePanel /> : visibleSection === 'runtime'
        ? <RuntimeCapabilitiesPanel capabilities={harnessCapabilities} runtime={harnessRuntime} version={harnessVersion} onCheckModelProvider={onCheckModelProvider} toolsMode={toolsMode} onToolsModeChange={onToolsModeChange} allowShell={allowShell} onAllowShellChange={onAllowShellChange} allowLsp={allowLsp} onAllowLspChange={onAllowLspChange} allowExternalAgents={allowExternalAgents} onAllowExternalAgentsChange={onAllowExternalAgentsChange} allowHooks={allowHooks} onAllowHooksChange={onAllowHooksChange} /> : visibleSection === 'profile'
        ? <section className="profile-settings settings-panel"><header><span><UserRound size={18} /></span><div><h2>个人资料</h2><p>当前登录的企业账号信息。</p></div></header><dl><div><dt>姓名</dt><dd>{displayName}</dd></div><div><dt>员工账号</dt><dd>{employeeId}</dd></div><div><dt>部门</dt><dd>{department || '未设置'}</dd></div><div><dt>岗位</dt><dd>{position || '未设置'}</dd></div><div><dt>企业</dt><dd>{companyName}</dd></div></dl></section>
        : visibleSection === 'memory'
        ? <MemoryPage
            accessToken={accessToken}
            employeeId={employeeId}
            endpoint={memoryEndpoint}
            onSaved={onMemorySaved}
            onOpenTask={onOpenMemoryTask}
          />
        : visibleSection === 'shortcuts'
            ? <section className="shortcut-settings settings-panel"><header><span><Keyboard size={18} /></span><div><h2>键盘快捷键</h2><p>以下快捷键在小胤任意页面可用。</p></div></header><dl><div><dt>搜索任务</dt><dd><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd><small>macOS 使用 ⌘ K</small></dd></div><div><dt>发送消息</dt><dd><kbd>Enter</kbd><small>Shift + Enter 换行</small></dd></div><div><dt>关闭菜单或弹窗</dt><dd><kbd>Esc</kbd></dd></div><div><dt>拖入本地文件</dt><dd><span>直接拖到对话</span><small>自动授权文件所在目录</small></dd></div></dl></section>
            : <section className="update-settings settings-panel"><header><span><RefreshCw size={18} /></span><div><h2>更新应用</h2><p>检查并安装小胤桌面端的新版本。</p></div></header><div><DesktopUpdater /></div></section>}
    </section>
  </div>
}

const capabilityLabels: Record<string, string> = {
  profile: 'SDK Profile', modelProvider: 'DeepSeek 模型供应商', agentLoop: 'Agent Loop', sdkJsonRpc: 'SDK 通信', sessionPersistence: '会话持久化', sessionCheckpoint: '会话检查点',
  sessionProjection: '会话投影', projectionCache: '投影缓存', sandbox: '沙箱', approval: '审批', planMode: '计划模式',
  askUser: '结构化提问', filesystem: '文件系统', fileSearch: '文件搜索', skills: '技能运行时', commands: 'Harness 命令', commandFeedback: '命令反馈', subagent: '进程内子 Agent',
  todo: 'Todo', goal: 'Goal', ralph: 'Ralph', workflow: 'Workflow', compaction: '上下文整理', toolResultPruner: '工具结果裁剪',
  tokenMeter: 'Token Meter', jobs: '后台 Jobs', webSearch: 'Web Search', webFetch: 'Web Fetch', spillPolicy: '大输出 Spill',
  settings: 'Harness Settings', credentials: 'Harness Credentials', llmRetry: '模型重试', outputRetention: '输出保留策略',
  timeoutPolicy: '超时策略', sessionQuery: '会话查询引擎', sessionQueryTools: '会话查询工具', sessionReference: '跨会话引用', sessionReminders: '会话内提醒', codeRuntime: 'Code Runtime / PTC', shell: 'Shell', browser: '浏览器',
  persistentTerminal: '持久终端',
  mcpClient: 'Harness MCP Client', officialAttachment: 'Harness 附件存储', officialFilesystem: 'Harness 文件系统', present: '文件交付声明',
  lsp: 'LSP', codexHooks: 'Codex Hooks', claudeHooks: 'Claude Hooks', codexSubagent: 'Codex 子 Agent',
  claudeSubagent: 'Claude 子 Agent', acpSubagent: 'ACP 子 Agent', dshSubagent: 'DSH 子 Agent',
}

const capabilityGuidance: Record<string, string> = {
  profile: '只有官方 Profile 完成启动后才标记为已启用',
  modelProvider: '仅表示凭据已配置；实际网络和模型可用性需通过任务或外部验收确认',
  codeRuntime: '需在运行环境显式开启 PTC，权限接近 Shell',
  persistentTerminal: '跨多次工具调用保留终端状态；仍受桌面 Shell 开关和审批约束',
  shell: '受桌面 Shell 策略、沙箱和审批共同约束',
  browser: '需启用浏览器连接器并满足系统浏览器权限',
  lsp: '需提供明确的 LSP server map，不自动猜测可执行文件',
  codexHooks: '需提供 Hooks 配置路径，可能执行本机命令',
  claudeHooks: '需提供 Hooks 配置路径，可能执行本机命令',
  codexSubagent: '需安装并登录 Codex 外部 Agent',
  claudeSubagent: '需安装并登录 Claude Code 外部 Agent',
  acpSubagent: '需配置 ACP Agent 命令和运行权限',
  dshSubagent: '需显式启用独立 DSH SDK 子 Agent',
  sessionQuery: '桌面历史搜索使用官方 SQLite 索引，不受模型查询工具开关影响',
  sessionQueryTools: '模型查询工具按会话与工作目录权限过滤；可单独关闭',
  sessionReference: '使用 dsh-session 引用其他会话的有界快照，来源内容按不可信上下文处理',
  sessionReminders: '仅在当前 Session 内投递提醒；跨重启计划由小胤定时任务负责',
  mcpClient: '仅无白名单且无需写审批、审计的连接器可走官方 Client；健康状态不代表已连接',
  officialAttachment: '小胤 backend 实现 Harness AttachmentStore，图片引用统一由 Harness admission 管理',
  officialFilesystem: '有授权目录时由小胤目录策略托管，避免与 local_files_* 重复暴露',
  present: '无授权目录时使用 Harness present；选择小胤目录后改用 local_files_publish',
}

function RuntimeCapabilitiesPanel({ capabilities, runtime, version, onCheckModelProvider, toolsMode, onToolsModeChange, allowShell, onAllowShellChange, allowLsp, onAllowLspChange, allowExternalAgents, onAllowExternalAgentsChange, allowHooks, onAllowHooksChange }: { capabilities: Record<string, 'enabled' | 'gated' | 'unconfigured'>; runtime?: string; version?: string; onCheckModelProvider?: () => Promise<HarnessProviderCheckResult>; toolsMode: HarnessToolsMode; onToolsModeChange: (value: HarnessToolsMode) => void; allowShell: boolean; onAllowShellChange: (value: boolean) => void; allowLsp: boolean; onAllowLspChange: (value: boolean) => void; allowExternalAgents: boolean; onAllowExternalAgentsChange: (value: boolean) => void; allowHooks: boolean; onAllowHooksChange: (value: boolean) => void }) {
  const entries = Object.entries(capabilities)
  const [providerCheck, setProviderCheck] = useState<HarnessProviderCheckResult>()
  const [providerChecking, setProviderChecking] = useState(false)
  const groups: Array<['enabled' | 'gated' | 'unconfigured', string]> = [['enabled', '已启用'], ['gated', '受控'], ['unconfigured', '未配置']]
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
  return <section className="settings-panel runtime-settings"><header><span><Activity size={18} /></span><div><h2>运行时能力</h2><p>{runtime ? `${runtime} · ${version ?? '未知版本'}` : '等待 Harness Host 健康检查结果'}</p></div></header>
    <div className="runtime-diagnostics-toolbar"><span>仅包含版本与能力状态，不包含会话内容或凭据。</span><div><button disabled={providerChecking || !onCheckModelProvider} onClick={async () => { if (!onCheckModelProvider) return; setProviderChecking(true); setProviderCheck(undefined); try { setProviderCheck(await onCheckModelProvider()) } catch (reason) { setProviderCheck({ status: 'unreachable', latencyMs: 0, detail: reason instanceof Error ? reason.message : '检查失败，请重试' }) } finally { setProviderChecking(false) } }} type="button"><RefreshCw size={14} />{providerChecking ? '检查中' : '检查模型服务'}</button><button onClick={exportDiagnostics} type="button"><Download size={14} />导出诊断</button></div></div>
    {providerCheck && <p className={`runtime-provider-check ${providerCheck.status}`} role="status">模型服务：{providerCheck.detail}{providerCheck.latencyMs > 0 ? ` · ${providerCheck.latencyMs}ms` : ''}</p>}
    <label className="runtime-tools-mode"><span><strong>工具运行模式</strong><small>PTC 会执行模型生成的 TypeScript，权限接近 Shell</small></span><select value={toolsMode} onChange={(event) => onToolsModeChange(event.target.value as HarnessToolsMode)}><option value="native">Native</option><option value="ptc">PTC</option><option value="both">Both</option></select></label>
    <label className="runtime-tools-mode"><span><strong>本地 Shell 与持久终端</strong><small>关闭后禁用 Bash、PowerShell 和跨调用终端状态；任务会重新启动 Harness。</small></span><input aria-label="启用本地 Shell 与持久终端" checked={allowShell} onChange={(event) => onAllowShellChange(event.target.checked)} type="checkbox" /></label>
    <label className="runtime-tools-mode"><span><strong>LSP 语言服务</strong><small>仅加载外部明确配置的 stdio Server；关闭后当前任务不挂载任何 LSP。</small></span><input aria-label="启用 LSP 语言服务" checked={allowLsp} onChange={(event) => onAllowLspChange(event.target.checked)} type="checkbox" /></label>
    <label className="runtime-tools-mode"><span><strong>外部 Agent</strong><small>允许已配置的 Codex、Claude、ACP 或 DSH 子 Agent；默认关闭，可能启动本机进程。</small></span><input aria-label="启用外部 Agent" checked={allowExternalAgents} onChange={(event) => onAllowExternalAgentsChange(event.target.checked)} type="checkbox" /></label>
    <label className="runtime-tools-mode"><span><strong>Hooks</strong><small>允许已配置的 Codex 或 Claude Hooks 执行本机命令；默认关闭。</small></span><input aria-label="启用 Hooks" checked={allowHooks} onChange={(event) => onAllowHooksChange(event.target.checked)} type="checkbox" /></label>
    {entries.length === 0 ? <p className="runtime-empty">当前没有可读取的 Harness 能力状态。</p> : groups.map(([status, title]) => {
      const items = entries.filter(([, value]) => value === status)
      if (items.length === 0) return null
      return <section className="runtime-capability-group" key={status}><h3><span className={`runtime-dot ${status}`} />{title}<small>{items.length}</small></h3><ul>{items.map(([key]) => <li key={key}><span><strong>{capabilityLabels[key] ?? key}</strong>{capabilityGuidance[key] && <small>{capabilityGuidance[key]}</small>}</span><code>{key}</code></li>)}</ul></section>
    })}
  </section>
}
