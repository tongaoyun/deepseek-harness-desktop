import { invoke, isTauri } from '@tauri-apps/api/core'
import type {
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  ExpertKitDownload,
  InstalledExpertKit,
} from './types'

export type ExpertKitInstallState = 'available' | 'installed' | 'update'

export interface ExpertKitView extends ExpertKitCatalogEntry {
  installState: ExpertKitInstallState
  readiness: 'ready' | 'partial'
  connectorIssues: string[]
  installedVersion?: string
  installed?: InstalledExpertKit
}

export async function listInstalledExpertKits(): Promise<InstalledExpertKit[]> {
  if (!isTauri()) return []
  return invoke<InstalledExpertKit[]>('list_installed_expert_kits')
}

export async function installExpertKit(download: ExpertKitDownload): Promise<InstalledExpertKit> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中安装专家套件')
  return invoke<InstalledExpertKit>('install_expert_kit', {
    request: {
      id: download.id,
      version: download.version,
      sha256: download.sha256,
      url: download.url,
    },
  })
}

export function mergeExpertKits(
  catalog: ExpertKitCatalogEntry[],
  installed: InstalledExpertKit[],
  connectors: ConnectorCatalogEntry[] = [],
): ExpertKitView[] {
  const newestInstalled = new Map<string, InstalledExpertKit>()
  for (const kit of installed) {
    if (!newestInstalled.has(kit.manifest.id)) newestInstalled.set(kit.manifest.id, kit)
  }

  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const readiness = (refs: string[], requiredTools: string[]) => {
    const referencedConnectors = refs
      .map((id) => connectorById.get(id))
      .filter((connector): connector is ConnectorCatalogEntry => connector !== undefined)
    const connectorIssues = refs.flatMap((id) => {
      const connector = connectorById.get(id)
      if (!connector) return [`${id} 未发布`]
      if (connector.status === 'ready') return []
      return [`${connector.name}：${connectorStatusLabel(connector.status)}`]
    })
    const providedTools = new Set(referencedConnectors.flatMap((connector) => connector.toolNames))
    for (const tool of requiredTools) {
      if (!providedTools.has(tool)) connectorIssues.push(`${tool} 无可用连接器`)
    }
    return { readiness: connectorIssues.length > 0 ? 'partial' as const : 'ready' as const, connectorIssues }
  }

  const views = catalog.map((kit): ExpertKitView => {
    const local = newestInstalled.get(kit.id)
    return {
      ...kit,
      commandIds: kit.commandIds ?? [],
      skillIds: kit.skillIds ?? [],
      connectorRefs: kit.connectorRefs ?? [],
      requiredTools: kit.requiredTools ?? [],
      serverWorkflows: kit.serverWorkflows ?? [],
      ...readiness(kit.connectorRefs ?? [], kit.requiredTools ?? []),
      installed: local,
      installedVersion: local?.manifest.version,
      installState: local?.manifest.version === kit.version
        ? 'installed'
        : local ? 'update' : 'available',
    }
  })
  const catalogIds = new Set(catalog.map((kit) => kit.id))
  for (const local of newestInstalled.values()) {
    if (catalogIds.has(local.manifest.id)) continue
    views.push({
      id: local.manifest.id,
      name: local.manifest.name,
      version: local.manifest.version,
      summary: local.manifest.summary,
      minimumDesktopVersion: local.manifest.minimumDesktopVersion,
      commandIds: local.manifest.commands.map((command) => command.id),
      skillIds: local.manifest.skills.map((skill) => skill.id),
      connectorRefs: local.manifest.connectorRefs,
      requiredTools: local.manifest.requiredTools,
      serverWorkflows: local.manifest.serverWorkflows,
      sha256: '',
      ...readiness(local.manifest.connectorRefs, local.manifest.requiredTools),
      installState: 'installed',
      installedVersion: local.manifest.version,
      installed: local,
    })
  }
  return views
}

function connectorStatusLabel(status: ConnectorCatalogEntry['status']): string {
  return ({
    ready: '已就绪',
    'needs-configuration': '需要配置',
    unavailable: '当前不可用',
    disabled: '已停用',
  })[status]
}
