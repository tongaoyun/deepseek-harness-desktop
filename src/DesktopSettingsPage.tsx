import { BrainCircuit, Keyboard, MonitorCog } from 'lucide-react'
import { useState } from 'react'
import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition, RuntimeStatus } from './types'
import { DeviceCapabilitiesPage } from './DeviceCapabilitiesPage'
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
  onMemorySaved: (profile: MemoryProfile) => Promise<void> | void
}

type SettingsSection = 'memory' | 'capabilities' | 'shortcuts'

export function DesktopSettingsPage({
  accessToken,
  employeeId,
  memoryEndpoint,
  deviceEndpoint,
  connectors,
  runtimeConnectors,
  authorizedDirectoryCount,
  runtimeStatus,
  onMemorySaved,
}: DesktopSettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('memory')

  return <div className="desktop-settings">
    <aside className="settings-navigation" aria-label="桌面设置">
      <button className={section === 'memory' ? 'active' : ''} onClick={() => setSection('memory')} type="button">
        <BrainCircuit size={17} /><span><strong>记忆</strong><small>协作风格与工作手册</small></span>
      </button>
      <button className={section === 'capabilities' ? 'active' : ''} onClick={() => setSection('capabilities')} type="button">
        <MonitorCog size={17} /><span><strong>设备能力</strong><small>本地工具与运行状态</small></span>
      </button>
      <button className={section === 'shortcuts' ? 'active' : ''} onClick={() => setSection('shortcuts')} type="button">
        <Keyboard size={17} /><span><strong>快捷键</strong><small>更快地操作工作台</small></span>
      </button>
    </aside>
    <section className="settings-content">
      {section === 'memory'
        ? <MemoryPage
            accessToken={accessToken}
            employeeId={employeeId}
            endpoint={memoryEndpoint}
            onSaved={onMemorySaved}
          />
        : section === 'capabilities' ? <DeviceCapabilitiesPage
            accessToken={accessToken}
            authorizedDirectoryCount={authorizedDirectoryCount}
            connectors={connectors}
            employeeId={employeeId}
            endpoint={deviceEndpoint}
            runtimeConnectors={runtimeConnectors}
            runtimeStatus={runtimeStatus}
          />
          : <section className="shortcut-settings"><header><span><Keyboard size={18} /></span><div><h2>键盘快捷键</h2><p>以下快捷键在小胤工作台任意页面可用。</p></div></header><dl><div><dt>搜索最近任务</dt><dd><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd><small>macOS 使用 ⌘ K</small></dd></div><div><dt>发送消息</dt><dd><kbd>Enter</kbd><small>Shift + Enter 换行</small></dd></div><div><dt>关闭菜单或弹窗</dt><dd><kbd>Esc</kbd></dd></div><div><dt>拖入本地文件</dt><dd><span>直接拖到工作台</span><small>自动授权文件所在目录</small></dd></div></dl></section>}
    </section>
  </div>
}
