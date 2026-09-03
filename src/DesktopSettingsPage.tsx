import { BrainCircuit, Keyboard, MonitorCog, RefreshCw, UserRound } from 'lucide-react'
import { useState } from 'react'
import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition, RuntimeStatus } from './types'
import { DeviceCapabilitiesPage } from './DeviceCapabilitiesPage'
import { DesktopUpdater } from './DesktopUpdater'
import { MemoryPage } from './MemoryPage'
import type { MemoryProfile } from './memory'

interface DesktopSettingsPageProps {
  accessToken: string
  employeeId: string
  memoryEndpoint: string
  deviceEndpoint: string
  connectors: ConnectorCatalogEntry[]
  runtimeConnectors: ConnectorRuntimeDefinition[]
  authorizedDirectoryCount: number
  runtimeStatus: RuntimeStatus
  displayName: string
  department: string
  position: string
  companyName: string
  onMemorySaved: (profile: MemoryProfile) => Promise<void> | void
}

type SettingsSection = 'profile' | 'system' | 'shortcuts' | 'memory' | 'updates'

export function DesktopSettingsPage({
  accessToken,
  employeeId,
  memoryEndpoint,
  deviceEndpoint,
  connectors,
  runtimeConnectors,
  authorizedDirectoryCount,
  runtimeStatus,
  displayName,
  department,
  position,
  companyName,
  onMemorySaved,
}: DesktopSettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('profile')

  return <div className="desktop-settings">
    <aside className="settings-navigation" aria-label="桌面设置">
      <p>通用</p>
      <button className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')} type="button">
        <UserRound size={17} /><span><strong>个人资料</strong><small>企业身份与账户信息</small></span>
      </button>
      <button className={section === 'system' ? 'active' : ''} onClick={() => setSection('system')} type="button">
        <MonitorCog size={17} /><span><strong>系统设置</strong><small>本机能力与运行状态</small></span>
      </button>
      <button className={section === 'shortcuts' ? 'active' : ''} onClick={() => setSection('shortcuts')} type="button">
        <Keyboard size={17} /><span><strong>快捷键</strong><small>常用桌面操作</small></span>
      </button>
      <button className={section === 'memory' ? 'active' : ''} onClick={() => setSection('memory')} type="button">
        <BrainCircuit size={17} /><span><strong>记忆</strong><small>协作风格与工作手册</small></span>
      </button>
      <button className={section === 'updates' ? 'active' : ''} onClick={() => setSection('updates')} type="button">
        <RefreshCw size={17} /><span><strong>更新应用</strong><small>检查桌面端新版本</small></span>
      </button>
    </aside>
    <section className="settings-content">
      {section === 'profile'
        ? <section className="profile-settings settings-panel"><header><span><UserRound size={18} /></span><div><h2>个人资料</h2><p>当前登录的企业账号信息。</p></div></header><dl><div><dt>姓名</dt><dd>{displayName}</dd></div><div><dt>员工账号</dt><dd>{employeeId}</dd></div><div><dt>部门</dt><dd>{department || '未设置'}</dd></div><div><dt>岗位</dt><dd>{position || '未设置'}</dd></div><div><dt>企业</dt><dd>{companyName}</dd></div></dl></section>
        : section === 'memory'
        ? <MemoryPage
            accessToken={accessToken}
            employeeId={employeeId}
            endpoint={memoryEndpoint}
            onSaved={onMemorySaved}
          />
        : section === 'system' ? <section className="system-settings"><header><span><MonitorCog size={18} /></span><div><h2>系统设置</h2><p>检查这台电脑可供小胤使用的本地能力与运行状态。</p></div></header><DeviceCapabilitiesPage
            accessToken={accessToken}
            authorizedDirectoryCount={authorizedDirectoryCount}
            connectors={connectors}
            employeeId={employeeId}
            endpoint={deviceEndpoint}
            runtimeConnectors={runtimeConnectors}
            runtimeStatus={runtimeStatus}
          /></section>
          : section === 'shortcuts'
            ? <section className="shortcut-settings settings-panel"><header><span><Keyboard size={18} /></span><div><h2>键盘快捷键</h2><p>以下快捷键在小胤任意页面可用。</p></div></header><dl><div><dt>搜索最近任务</dt><dd><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd><small>macOS 使用 ⌘ K</small></dd></div><div><dt>发送消息</dt><dd><kbd>Enter</kbd><small>Shift + Enter 换行</small></dd></div><div><dt>关闭菜单或弹窗</dt><dd><kbd>Esc</kbd></dd></div><div><dt>拖入本地文件</dt><dd><span>直接拖到对话</span><small>自动授权文件所在目录</small></dd></div></dl></section>
            : <section className="update-settings settings-panel"><header><span><RefreshCw size={18} /></span><div><h2>更新应用</h2><p>检查并安装小胤桌面端的新版本。</p></div></header><div><DesktopUpdater /></div></section>}
    </section>
  </div>
}
