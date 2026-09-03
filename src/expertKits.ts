import { invoke, isTauri } from '@tauri-apps/api/core'
import type {
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  ExpertKitDownload,
  ExpertKitPermissions,
  InstalledExpertKit,
  ExpertKitManifest,
  KnowledgeBaseEntry,
} from './types'

export type ExpertKitInstallState = 'available' | 'installed' | 'update' | 'retired'

export interface ExpertKitView extends ExpertKitCatalogEntry {
  installState: ExpertKitInstallState
  readiness: 'ready' | 'partial'
  connectorIssues: string[]
  knowledgeIssues: string[]
  installedVersion?: string
  installed?: InstalledExpertKit
  localOnly: boolean
}

export const desktopToolNames = new Set([
  'office.document.read',
  'office.docx.create',
  'office.xlsx.create',
  'office.pdf.create',
  'local_shell_run',
  'computer_use_observe',
  'computer_use_click',
  'computer_use_type',
  'computer_use_key',
  'computer_use_scroll',
])

export async function listInstalledExtensions(): Promise<InstalledExpertKit[]> {
  if (!isTauri()) return []
  return invoke<InstalledExpertKit[]>('list_installed_expert_kits')
}

export async function installExtension(download: ExpertKitDownload, kind: 'expert-kit' | 'skill'): Promise<InstalledExpertKit> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中安装扩展')
  return invoke<InstalledExpertKit>('install_expert_kit', {
    request: {
      kind,
      id: download.id,
      version: download.version,
      sha256: download.sha256,
      url: download.url,
    },
  })
}

export async function developerExpertKitInstallEnabled(): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('developer_expert_kit_install_enabled')
}

export async function installDeveloperExpertKit(): Promise<InstalledExpertKit | null> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中安装本地验收套件')
  return invoke<InstalledExpertKit | null>('install_developer_expert_kit')
}

export interface DeveloperSkillSource {
  id: string
  version: string
}

export async function createDeveloperExtension(manifest: ExpertKitManifest, instructions: string, skillSources: DeveloperSkillSource[] = []): Promise<{ installed: InstalledExpertKit; bytes: number[] }> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中创建扩展')
  return invoke('create_developer_extension', { request: { manifest, instructions, skillSources } })
}

export interface DeveloperExtensionDraft {
  manifest: ExpertKitManifest
  instructions: string
}

export async function readDeveloperExtension(kind: 'expert-kit' | 'skill', id: string, version: string): Promise<DeveloperExtensionDraft> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中编辑扩展')
  return invoke<DeveloperExtensionDraft>('read_developer_extension', { kind, id, version })
}

export async function packageDeveloperExtension(kind: 'expert-kit' | 'skill', id: string, version: string): Promise<{ installed: InstalledExpertKit; bytes: number[] }> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中打包扩展')
  return invoke('package_developer_extension', { kind, id, version })
}

export async function removeDeveloperExtension(kind: 'expert-kit' | 'skill', id: string, version: string): Promise<void> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中删除扩展')
  await invoke('remove_developer_extension', { kind, id, version })
}

export async function createExpertKitTemplate(id: string, name: string): Promise<string | null> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中创建专家套件')
  return invoke<string | null>('create_expert_kit_template', { id, name })
}

export async function customizeExpertKit(id: string, version: string): Promise<string | null> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中定制专家套件')
  return invoke<string | null>('customize_expert_kit', { id, version })
}

export async function exportExpertKit(id: string, version: string): Promise<string | null> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中导出专家套件')
  return invoke<string | null>('export_expert_kit', { id, version })
}

export async function removeDeveloperExpertKit(id: string, version: string): Promise<void> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中移除本地验收套件')
  await invoke('remove_developer_expert_kit', { id, version })
}

export async function removeCatalogExtension(id: string, kind: 'expert-kit' | 'skill'): Promise<void> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中卸载扩展')
  await invoke('remove_catalog_extension', { id, kind })
}

export function mergeExpertKits(
  catalog: ExpertKitCatalogEntry[],
  installed: InstalledExpertKit[],
  connectors: ConnectorCatalogEntry[] = [],
  knowledgeBases: KnowledgeBaseEntry[] = [],
  enabledConnectorIds?: Iterable<string>,
): ExpertKitView[] {
  const newestInstalled = new Map<string, InstalledExpertKit>()
  for (const kit of installed) {
    if (kit.manifest.kind === 'skill') continue
    if (!newestInstalled.has(kit.manifest.id)) newestInstalled.set(kit.manifest.id, kit)
  }

  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeReferences = new Set(knowledgeBases.map((knowledgeBase) => knowledgeBase.reference))
  const enabled = enabledConnectorIds === undefined ? undefined : new Set(enabledConnectorIds)
  const readiness = (refs: string[], requiredTools: string[], knowledgeBaseRefs: string[]) => {
    const referencedConnectors = refs
      .map((id) => connectorById.get(id))
      .filter((connector): connector is ConnectorCatalogEntry => connector !== undefined)
    const connectorIssues = refs.flatMap((id) => {
      const connector = connectorById.get(id)
      if (!connector) return [`${id} 未发布`]
      if (connector.status === 'ready' && enabled?.has(id) === false) return [`${connector.name}：当前员工未启用`]
      if (connector.status === 'ready') return []
      return [`${connector.name}：${connectorStatusLabel(connector.status)}`]
    })
    const providedTools = new Set(referencedConnectors.flatMap((connector) => connector.toolNames))
    for (const tool of requiredTools.filter((name) => !desktopToolNames.has(name))) {
      if (!providedTools.has(tool)) connectorIssues.push(`${tool} 无可用连接器`)
    }
    const knowledgeIssues = knowledgeBaseRefs
      .filter((reference) => !knowledgeReferences.has(reference))
      .map((reference) => `${reference} 不存在或无访问权限`)
    return {
      readiness: connectorIssues.length > 0 || knowledgeIssues.length > 0 ? 'partial' as const : 'ready' as const,
      connectorIssues,
      knowledgeIssues,
    }
  }

  const views = catalog.map((kit): ExpertKitView => {
    const local = newestInstalled.get(kit.id)
    return {
      ...kit,
      commandIds: kit.commandIds ?? [],
      skillIds: kit.skillIds ?? [],
      connectorRefs: kit.connectorRefs ?? [],
      requiredTools: kit.requiredTools ?? [],
      knowledgeBaseRefs: kit.knowledgeBaseRefs ?? [],
      permissions: normalizePermissions(kit.permissions),
      serverWorkflows: kit.serverWorkflows ?? [],
      ...readiness(kit.connectorRefs ?? [], kit.requiredTools ?? [], kit.knowledgeBaseRefs ?? []),
      installed: local,
      localOnly: false,
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
      knowledgeBaseRefs: local.manifest.knowledgeBaseRefs ?? [],
      permissions: normalizePermissions(local.manifest.permissions),
      serverWorkflows: local.manifest.serverWorkflows,
      sha256: '',
      ...readiness(local.manifest.connectorRefs, local.manifest.requiredTools, local.manifest.knowledgeBaseRefs ?? []),
      installState: local.source === 'developer' ? 'installed' : 'retired',
      installedVersion: local.manifest.version,
      installed: local,
      localOnly: local.source === 'developer',
    })
  }
  return views
}

export function normalizePermissions(
  value: ExpertKitCatalogEntry['permissions'] | InstalledExpertKit['manifest']['permissions'] | undefined,
): ExpertKitPermissions {
  return {
    localFiles: value?.localFiles ?? 'deny',
    shell: value?.shell ?? 'deny',
    computerUse: value?.computerUse ?? 'deny',
    connectorRead: value?.connectorRead ?? 'deny',
    connectorWrite: value?.connectorWrite ?? 'deny',
  }
}

function connectorStatusLabel(status: ConnectorCatalogEntry['status']): string {
  return ({
    ready: '已就绪',
    'needs-configuration': '需要配置',
    unavailable: '当前不可用',
    disabled: '已停用',
  })[status]
}
