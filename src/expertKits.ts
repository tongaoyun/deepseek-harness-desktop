import { invoke, isTauri } from '@tauri-apps/api/core'
import type {
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  ExpertKitDownload,
  InstalledExpertKit,
  ExpertKitManifest,
  InstalledExtensionInventory,
  KnowledgeBaseEntry,
} from './types'
import { compareDesktopVersions, isDesktopVersionCompatible } from './extensionVersion'

export type ExpertKitInstallState = 'available' | 'installed' | 'retired' | 'incompatible'

const REMOVED_EXPERT_KIT_IDS = new Set(['crossborder-operations'])

export interface ExpertKitView extends ExpertKitCatalogEntry {
  installState: ExpertKitInstallState
  updateRequiresDesktopUpgrade?: boolean
  readiness: 'ready' | 'partial'
  connectorIssues: string[]
  knowledgeIssues: string[]
  installed?: InstalledExpertKit
  localOnly: boolean
}

export const desktopToolNames = new Set([
  'load_workspace_dependencies',
  'bash',
  'pwsh',
  'job_output',
  'job_list',
  'job_kill',
  'present',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'get_goal',
  'create_goal',
  'update_goal',
  'browser_open',
  'browser_snapshot',
  'browser_tabs',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_click',
  'browser_click_text',
  'browser_click_point',
  'browser_type',
  'browser_select',
  'browser_scroll',
  'browser_back',
  'browser_reload',
  'browser_press_key',
  'browser_wait_for',
  'browser_downloads',
  'browser_human_takeover',
  'browser_screenshot',
  'computer_use_observe',
  'computer_use_click',
  'computer_use_type',
  'computer_use_key',
  'computer_use_scroll',
])

export async function listInstalledExtensions(): Promise<InstalledExpertKit[]> {
  return (await inspectInstalledExtensions()).installed
}

export interface ExtensionDocument { id: string; name: string; summary: string; argumentHint?: string; userInvocable: boolean; path: string; content: string }
export interface ExtensionContents { readme: string; skills: ExtensionDocument[]; commands: ExtensionDocument[] }

export async function readExtensionContents(kind: 'expert-kit' | 'skill', id: string, version: string): Promise<ExtensionContents> {
  if (!isTauri()) throw new Error('请在桌面客户端中查看已安装扩展的原文')
  return invoke('read_extension_contents', { kind, id, version })
}

export async function setExtensionEnabled(extension: InstalledExpertKit, enabled: boolean): Promise<void> {
  if (!isTauri()) throw new Error('请在桌面客户端中设置扩展启停')
  const { kind, id, version } = extension.manifest
  await invoke('set_extension_enabled', { kind, id, version, enabled })
}

export async function revealExtensionDirectory(extension: InstalledExpertKit): Promise<void> {
  if (!isTauri()) throw new Error('请在桌面客户端中打开扩展文件夹')
  const { kind, id, version } = extension.manifest
  await invoke('reveal_extension_directory', { kind, id, version })
}

export async function inspectInstalledExtensions(): Promise<InstalledExtensionInventory> {
  if (!isTauri()) return { installed: [], issues: [] }
  return invoke<InstalledExtensionInventory>('list_installed_expert_kits')
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

export async function selectDeveloperExtension(kind: 'expert-kit' | 'skill', input: 'archive' | 'directory' = 'archive'): Promise<string[]> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中选择本地扩展')
  return invoke('select_developer_extension', { kind, input })
}
export async function installDeveloperExtension(kind: 'expert-kit' | 'skill', input: 'archive' | 'directory' = 'archive', path?: string): Promise<InstalledExpertKit | null> {
  if (!isTauri()) throw new Error(`请在小胤桌面客户端中安装本地${kind === 'skill' ? '技能' : '专家套件'}`)
  return invoke<InstalledExpertKit | null>('install_developer_extension', { kind, input, path })
}

export interface DeveloperSkillSource {
  id: string
  version: string
}

export async function createDeveloperExtension(manifest: ExpertKitManifest, instructions: string, skillSources: DeveloperSkillSource[] = [], base?: DeveloperSkillSource): Promise<{ installed: InstalledExpertKit; bytes: number[] }> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中创建扩展')
  return invoke('create_developer_extension', { request: { manifest, instructions, skillSources, base } })
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

export async function customizeExpertKit(id: string, version: string, kind: 'expert-kit' | 'skill' = 'expert-kit'): Promise<string | null> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中定制专家套件')
  return invoke<string | null>('customize_expert_kit', { id, version, kind })
}

export async function exportExpertKit(id: string, version: string, kind: 'expert-kit' | 'skill' = 'expert-kit'): Promise<string | null> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中导出专家套件')
  return invoke<string | null>('export_expert_kit', { id, version, kind })
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
  const newestDeveloper = new Map<string, InstalledExpertKit>()
  for (const kit of installed) {
    if (kit.manifest.kind === 'skill') continue
    if (REMOVED_EXPERT_KIT_IDS.has(kit.manifest.id)) continue
    const previous = newestInstalled.get(kit.manifest.id)
    if (!previous || (compareDesktopVersions(kit.manifest.version, previous.manifest.version) ?? -1) > 0) newestInstalled.set(kit.manifest.id, kit)
    if (kit.source === 'developer') {
      const previousDeveloper = newestDeveloper.get(kit.manifest.id)
      if (!previousDeveloper || (compareDesktopVersions(kit.manifest.version, previousDeveloper.manifest.version) ?? -1) > 0) newestDeveloper.set(kit.manifest.id, kit)
    }
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

  const activeCatalog = catalog.filter((kit) => !REMOVED_EXPERT_KIT_IDS.has(kit.id))
  const views = activeCatalog.map((kit): ExpertKitView => {
    const local = newestDeveloper.get(kit.id)
      ?? installed.find((value) => value.manifest.kind === 'expert-kit'
      && value.manifest.id === kit.id && value.manifest.version === kit.version)
      ?? newestInstalled.get(kit.id)
    // Developer artifacts are the source of truth while iterating locally. A
    // same-id catalog entry must not leave the UI describing one version while
    // invocation and execution use another.
    const developer = local?.source === 'developer' ? local.manifest : undefined
    const metadata: ExpertKitCatalogEntry = developer ? {
      ...kit,
      id: developer.id,
      name: developer.name,
      author: developer.author,
      version: developer.version,
      summary: developer.summary,
      category: developer.category,
      minimumDesktopVersion: developer.minimumDesktopVersion,
      commandIds: developer.commands.map((command) => command.id),
      skillIds: developer.skills.map((skill) => skill.id),
      skillDetails: [],
      connectorRefs: developer.connectorRefs,
      requiredTools: developer.requiredTools,
      knowledgeBaseRefs: developer.knowledgeBaseRefs ?? [],
      sha256: local?.packageSha256 ?? '',
    } : kit
    const catalogCompatible = isDesktopVersionCompatible(metadata.minimumDesktopVersion)
    const localCompatible = local ? isDesktopVersionCompatible(local.manifest.minimumDesktopVersion) : false
    return {
      ...metadata,
      commandIds: metadata.commandIds ?? [],
      skillIds: metadata.skillIds ?? [],
      skillDetails: metadata.skillDetails ?? [],
      connectorRefs: metadata.connectorRefs ?? [],
      requiredTools: metadata.requiredTools ?? [],
      knowledgeBaseRefs: metadata.knowledgeBaseRefs ?? [],
      ...readiness(metadata.connectorRefs ?? [], metadata.requiredTools ?? [], metadata.knowledgeBaseRefs ?? []),
      installed: local,
      localOnly: !!developer,
      updateRequiresDesktopUpgrade: !developer && !!local && localCompatible && !catalogCompatible,
      installState: local && localCompatible ? 'installed' : catalogCompatible ? 'available' : 'incompatible',
    }
  })
  const catalogIds = new Set(activeCatalog.map((kit) => kit.id))
  const localViews = new Map(newestInstalled)
  for (const [id, local] of newestDeveloper) localViews.set(id, local)
  for (const local of localViews.values()) {
    if (catalogIds.has(local.manifest.id)) continue
    views.push({
      id: local.manifest.id,
      name: local.manifest.name,
      author: local.manifest.author,
      version: local.manifest.version,
      summary: local.manifest.summary,
      category: local.manifest.category,
      minimumDesktopVersion: local.manifest.minimumDesktopVersion,
      commandIds: local.manifest.commands.map((command) => command.id),
      skillIds: local.manifest.skills.map((skill) => skill.id),
      skillDetails: [],
      connectorRefs: local.manifest.connectorRefs,
      requiredTools: local.manifest.requiredTools,
      knowledgeBaseRefs: local.manifest.knowledgeBaseRefs ?? [],
      sha256: local.packageSha256 ?? '',
      ...readiness(local.manifest.connectorRefs, local.manifest.requiredTools, local.manifest.knowledgeBaseRefs ?? []),
      installState: local.source === 'developer'
        ? isDesktopVersionCompatible(local.manifest.minimumDesktopVersion) ? 'installed' : 'incompatible'
        : 'retired',
      installed: local,
      localOnly: local.source === 'developer',
    })
  }
  return views
}

export interface PublishedExtensionCoordinate {
  kind: InstalledExpertKit['manifest']['kind']
  id: string
  version: string
}

export function installedExtensionSnapshot(
  installed: InstalledExpertKit[],
  published: PublishedExtensionCoordinate[],
) {
  const unique = new Map<string, InstalledExpertKit>()
  for (const extension of installed.filter((item) => item.source === 'developer')) {
    const coordinate = `${extension.manifest.kind}:${extension.manifest.id}`
    if (!unique.has(coordinate)) unique.set(coordinate, extension)
  }
  for (const coordinate of published) {
    const extension = installed.find((item) => item.source === 'catalog'
      && item.manifest.kind === coordinate.kind
      && item.manifest.id === coordinate.id
      && item.manifest.version === coordinate.version)
    if (extension) unique.set(`${coordinate.kind}:${coordinate.id}`, extension)
  }
  return [...unique.values()].sort((left, right) =>
    `${left.manifest.kind}:${left.manifest.id}`.localeCompare(`${right.manifest.kind}:${right.manifest.id}`),
  ).map((extension) => ({
    kind: extension.manifest.kind,
    id: extension.manifest.id,
    version: extension.manifest.version,
    source: extension.source,
  }))
}

function connectorStatusLabel(status: ConnectorCatalogEntry['status']): string {
  return ({
    ready: '已就绪',
    'needs-configuration': '需要配置',
    unavailable: '当前不可用',
    disabled: '已停用',
  })[status]
}
