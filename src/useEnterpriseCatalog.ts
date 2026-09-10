import { useCallback, useEffect, useRef, useState } from 'react'
import { createExpertKitDownload, loadConnectors, loadExpertKits, loadKnowledgeBases, loadSkills } from './api'
import type { ErpUser } from './auth'
import { withDesktopBuiltinConnectors } from './connectors'
import { loadEnterpriseCatalogCache, saveEnterpriseCatalogCache } from './enterpriseCache'
import { inspectInstalledExtensions, installExtension, mergeExpertKits, type ExpertKitView } from './expertKits'
import { synchronizePublishedExpertKits } from './expertKitSync'
import { isPersonalConnector, loadPersonalConnectors } from './extensionSubmissions'
import { mergeSkills, type SkillView } from './skills'
import type {
  BootstrapResponse,
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  InstalledExpertKit,
  KnowledgeBaseEntry,
  SkillCatalogEntry,
} from './types'

export interface ExtensionSyncIssue {
  key: string
  label: string
  message: string
  removable?: boolean
}

interface CatalogData {
  catalog: ExpertKitCatalogEntry[]
  installed: InstalledExpertKit[]
  skills: SkillCatalogEntry[]
  connectors: ConnectorCatalogEntry[]
  knowledge: KnowledgeBaseEntry[]
}

const emptyCatalog = (): CatalogData => ({ catalog: [], installed: [], skills: [], connectors: [], knowledge: [] })

export function useEnterpriseCatalog({
  accessToken,
  bootstrap,
  enabledConnectorIds,
  user,
}: {
  accessToken: string
  bootstrap?: BootstrapResponse
  enabledConnectorIds: string[]
  user: ErpUser | null
}) {
  const [expertKits, setExpertKits] = useState<ExpertKitView[]>([])
  const [expertKitCatalog, setExpertKitCatalog] = useState<ExpertKitCatalogEntry[]>([])
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [skillViews, setSkillViews] = useState<SkillView[]>([])
  const [connectors, setConnectors] = useState<ConnectorCatalogEntry[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [syncIssues, setSyncIssues] = useState<ExtensionSyncIssue[]>([])
  const [syncedAt, setSyncedAt] = useState<Date>()
  const [cacheSavedAt, setCacheSavedAt] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const cacheRef = useRef<CatalogData>(emptyCatalog())
  const catalogOwnerRef = useRef('')
  const inventoryRevisionRef = useRef(0)
  const cacheLoadedRef = useRef(false)
  const enabledConnectorIdsRef = useRef(enabledConnectorIds)

  const applyCatalog = useCallback((data = cacheRef.current) => {
    setExpertKitCatalog(data.catalog)
    setSkills(data.skills)
    setConnectors(data.connectors)
    setKnowledgeBases(data.knowledge)
    setExpertKits(mergeExpertKits(data.catalog, data.installed, data.connectors, data.knowledge, enabledConnectorIdsRef.current))
    setSkillViews(mergeSkills(data.skills, data.installed, data.connectors, data.knowledge, enabledConnectorIdsRef.current))
  }, [])

  useEffect(() => {
    enabledConnectorIdsRef.current = enabledConnectorIds
    applyCatalog()
  }, [applyCatalog, enabledConnectorIds])

  useEffect(() => {
    if (!bootstrap || !user) {
      cacheRef.current = emptyCatalog()
      catalogOwnerRef.current = ''
      cacheLoadedRef.current = false
      inventoryRevisionRef.current += 1
      setLoading(false)
      setCacheSavedAt('')
      setSyncIssues([])
      setSyncedAt(undefined)
      applyCatalog()
      return
    }
    if (catalogOwnerRef.current !== user.userId) {
      cacheRef.current = emptyCatalog()
      catalogOwnerRef.current = user.userId
      cacheLoadedRef.current = false
      inventoryRevisionRef.current += 1
      setCacheSavedAt('')
      setSyncIssues([])
      setSyncedAt(undefined)
      applyCatalog()
    }
    const controller = new AbortController()
    let syncing = false
    const synchronize = async (showLoading: boolean) => {
      if (syncing) return
      syncing = true
      if (showLoading) setLoading(true)
      setSyncIssues([])
      try {
        if (showLoading && !cacheLoadedRef.current) {
          const cached = await loadEnterpriseCatalogCache(user.userId).catch(() => undefined)
          if (controller.signal.aborted) return
          cacheLoadedRef.current = true
          if (cached && cacheRef.current.catalog.length === 0) {
            const personal = loadPersonalConnectors(user.userId)
            cacheRef.current = {
              ...cacheRef.current,
              ...cached,
              connectors: withDesktopBuiltinConnectors([
                ...personal,
                ...cached.connectors.filter((item) => !isPersonalConnector(item) && !personal.some((value) => value.id === item.id)),
              ]),
            }
            setCacheSavedAt(cached.savedAt)
            applyCatalog()
          }
        }
        const inventoryRevision = inventoryRevisionRef.current
        const results = await Promise.allSettled([
          loadExpertKits(bootstrap.endpoints.expertKits, user.userId, accessToken, controller.signal),
          inspectInstalledExtensions(),
          loadSkills(bootstrap.endpoints.skills, user.userId, accessToken, controller.signal),
          loadConnectors(bootstrap.endpoints.connectors, user.userId, accessToken, controller.signal),
          loadKnowledgeBases(bootstrap.endpoints.knowledge, user.userId, user.teamId, accessToken, controller.signal),
        ] as const)
        if (controller.signal.aborted) return
        const [catalogResult, installedResult, skillsResult, connectorsResult, knowledgeResult] = results
        const data = cacheRef.current
        if (catalogResult.status === 'fulfilled') data.catalog = catalogResult.value
        const currentInventory = inventoryRevision === inventoryRevisionRef.current
        let expertKitSyncIssues: ExtensionSyncIssue[] = []
        if (currentInventory && installedResult.status === 'fulfilled') {
          data.installed = installedResult.value.installed
          if (catalogResult.status === 'fulfilled') {
            const synchronized = await synchronizePublishedExpertKits(catalogResult.value, data.installed, {
              download: (id) => createExpertKitDownload(bootstrap.endpoints.expertKits, id, user.userId, accessToken),
              install: (download) => installExtension(download, 'expert-kit'),
            })
            if (controller.signal.aborted) return
            data.installed = synchronized.installed
            expertKitSyncIssues = synchronized.issues
          }
        }
        if (skillsResult.status === 'fulfilled') data.skills = skillsResult.value
        if (connectorsResult.status === 'fulfilled') {
          const personal = loadPersonalConnectors(user.userId)
          data.connectors = withDesktopBuiltinConnectors([
            ...personal,
            ...connectorsResult.value.filter((item) => !personal.some((value) => value.id === item.id)),
          ])
        } else {
          const personal = loadPersonalConnectors(user.userId)
          data.connectors = withDesktopBuiltinConnectors([
            ...personal,
            ...data.connectors.filter((item) => !isPersonalConnector(item) && !personal.some((value) => value.id === item.id)),
          ])
        }
        if (knowledgeResult.status === 'fulfilled') data.knowledge = knowledgeResult.value
        applyCatalog()
        const sources = [
          ['expert-kits', '专家套件目录', catalogResult],
          ['installed', '本机已安装能力', installedResult],
          ['skills', '技能目录', skillsResult],
          ['connectors', '连接器目录', connectorsResult],
          ['knowledge', '知识库目录', knowledgeResult],
        ] as const
        const sourceIssues = sources.flatMap(([key, label, result]) => result.status === 'rejected' && (key !== 'installed' || currentInventory)
          ? [{ key, label, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
          : [])
        const localIssues = currentInventory && installedResult.status === 'fulfilled'
          ? installedResult.value.issues.map((issue) => ({
            key: `local-extension:${issue.coordinate}`,
            label: issue.coordinate,
            message: issue.message,
            removable: removableCoordinate(issue.coordinate),
          }))
          : []
        setSyncIssues((current) => [...sourceIssues, ...expertKitSyncIssues, ...(currentInventory ? localIssues : current.filter((issue) => issue.key.startsWith('local-extension:')))])
        setSyncedAt(new Date())
        if ([catalogResult, skillsResult, connectorsResult, knowledgeResult].every((result) => result.status === 'fulfilled')) {
          const savedAt = new Date().toISOString()
          setCacheSavedAt(savedAt)
          void saveEnterpriseCatalogCache(user.userId, {
            savedAt, catalog: data.catalog, skills: data.skills, connectors: data.connectors.filter((item) => !isPersonalConnector(item)), knowledge: data.knowledge,
          }).catch(() => undefined)
        }
      } finally {
        syncing = false
        if (showLoading && !controller.signal.aborted) setLoading(false)
      }
    }
    void synchronize(true)
    const timer = window.setInterval(() => void synchronize(false), 60_000)
    const onFocus = () => { void synchronize(false) }
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); controller.abort() }
  }, [accessToken, applyCatalog, bootstrap, refreshKey, user])

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  const refreshInstalled = useCallback(async () => {
    const owner = catalogOwnerRef.current
    const revision = ++inventoryRevisionRef.current
    const inventory = await inspectInstalledExtensions()
    if (owner !== catalogOwnerRef.current || revision !== inventoryRevisionRef.current) return inventory.installed
    cacheRef.current.installed = inventory.installed
    applyCatalog()
    setSyncIssues((current) => [
      ...current.filter((issue) => issue.key !== 'installed' && !issue.key.startsWith('local-extension:')),
      ...inventory.issues.map((issue) => ({
        key: `local-extension:${issue.coordinate}`,
        label: issue.coordinate,
        message: issue.message,
        removable: removableCoordinate(issue.coordinate),
      })),
    ])
    return inventory.installed
  }, [applyCatalog])

  const replaceConnectors = useCallback((next: ConnectorCatalogEntry[] | ((current: ConnectorCatalogEntry[]) => ConnectorCatalogEntry[])) => {
    cacheRef.current.connectors = typeof next === 'function' ? next(cacheRef.current.connectors) : next
    applyCatalog()
  }, [applyCatalog])

  return {
    cacheSavedAt,
    connectors,
    expertKitCatalog,
    expertKits,
    knowledgeBases,
    loading,
    refresh,
    refreshInstalled,
    replaceConnectors,
    skills,
    skillViews,
    syncIssues,
    syncedAt,
  }
}

function removableCoordinate(value: string): boolean {
  return /^(expert-kit|skill):[a-z][a-z0-9-]{2,63}@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}
