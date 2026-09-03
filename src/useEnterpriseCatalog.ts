import { useCallback, useEffect, useRef, useState } from 'react'
import { loadConnectors, loadExpertKits, loadKnowledgeBases, loadSkills } from './api'
import type { ErpUser } from './auth'
import { withDesktopBuiltinConnectors } from './connectors'
import { loadEnterpriseCatalogCache, saveEnterpriseCatalogCache } from './enterpriseCache'
import { listInstalledExtensions, mergeExpertKits, type ExpertKitView } from './expertKits'
import { loadPersonalConnectors } from './extensionSubmissions'
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
      setCacheSavedAt('')
      setSyncIssues([])
      setSyncedAt(undefined)
      applyCatalog()
      return
    }
    if (catalogOwnerRef.current !== user.userId) {
      cacheRef.current = emptyCatalog()
      catalogOwnerRef.current = user.userId
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
        if (showLoading) {
          const cached = await loadEnterpriseCatalogCache(user.userId).catch(() => undefined)
          if (cached && cacheRef.current.catalog.length === 0) {
            const personal = loadPersonalConnectors(user.userId)
            cacheRef.current = {
              ...cacheRef.current,
              ...cached,
              connectors: withDesktopBuiltinConnectors([
                ...personal,
                ...cached.connectors.filter((item) => !personal.some((value) => value.id === item.id)),
              ]),
            }
            setCacheSavedAt(cached.savedAt)
            applyCatalog()
          }
        }
        const results = await Promise.allSettled([
          loadExpertKits(bootstrap.endpoints.expertKits, user.userId, accessToken, controller.signal),
          listInstalledExtensions(),
          loadSkills(bootstrap.endpoints.skills, user.userId, accessToken, controller.signal),
          loadConnectors(bootstrap.endpoints.connectors, user.userId, accessToken, controller.signal),
          loadKnowledgeBases(bootstrap.endpoints.knowledge, user.userId, user.teamId, accessToken, controller.signal),
        ] as const)
        if (controller.signal.aborted) return
        const [catalogResult, installedResult, skillsResult, connectorsResult, knowledgeResult] = results
        const data = cacheRef.current
        if (catalogResult.status === 'fulfilled') data.catalog = catalogResult.value
        if (installedResult.status === 'fulfilled') data.installed = installedResult.value
        if (skillsResult.status === 'fulfilled') data.skills = skillsResult.value
        if (connectorsResult.status === 'fulfilled') {
          const personal = loadPersonalConnectors(user.userId)
          data.connectors = withDesktopBuiltinConnectors([
            ...personal,
            ...connectorsResult.value.filter((item) => !personal.some((value) => value.id === item.id)),
          ])
        }
        if (knowledgeResult.status === 'fulfilled') data.knowledge = knowledgeResult.value
        applyCatalog()
        const sources = [
          ['expert-kits', '专家套件目录', catalogResult],
          ['installed', '本机已安装能力', installedResult],
          ['skills', 'Skills 目录', skillsResult],
          ['connectors', '连接器目录', connectorsResult],
          ['knowledge', '知识库目录', knowledgeResult],
        ] as const
        setSyncIssues(sources.flatMap(([key, label, result]) => result.status === 'rejected'
          ? [{ key, label, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
          : []))
        setSyncedAt(new Date())
        if ([catalogResult, skillsResult, connectorsResult, knowledgeResult].every((result) => result.status === 'fulfilled')) {
          const savedAt = new Date().toISOString()
          setCacheSavedAt(savedAt)
          void saveEnterpriseCatalogCache(user.userId, {
            savedAt, catalog: data.catalog, skills: data.skills, connectors: data.connectors, knowledge: data.knowledge,
          }).catch(() => undefined)
        }
      } finally {
        syncing = false
        if (showLoading && !controller.signal.aborted) setLoading(false)
      }
    }
    void synchronize(true)
    const timer = window.setInterval(() => void synchronize(false), 60_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [accessToken, applyCatalog, bootstrap, refreshKey, user])

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  const refreshInstalled = useCallback(async () => {
    const installed = await listInstalledExtensions()
    cacheRef.current.installed = installed
    applyCatalog()
    return installed
  }, [applyCatalog])

  const replaceConnectors = useCallback((next: ConnectorCatalogEntry[]) => {
    cacheRef.current.connectors = next
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
