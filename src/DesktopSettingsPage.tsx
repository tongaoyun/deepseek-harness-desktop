import { BrainCircuit, MonitorCog } from 'lucide-react'
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

type SettingsSection = 'memory' | 'capabilities'

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
    </aside>
    <section className="settings-content">
      {section === 'memory'
        ? <MemoryPage
            accessToken={accessToken}
            employeeId={employeeId}
            endpoint={memoryEndpoint}
            onSaved={onMemorySaved}
          />
        : <DeviceCapabilitiesPage
            accessToken={accessToken}
            authorizedDirectoryCount={authorizedDirectoryCount}
            connectors={connectors}
            employeeId={employeeId}
            endpoint={deviceEndpoint}
            runtimeConnectors={runtimeConnectors}
            runtimeStatus={runtimeStatus}
          />}
    </section>
  </div>
}
