import { useCallback, useEffect, useRef, useState } from 'react'
import { createExpertKitDownload, createSkillDownload, loadConnectors, loadExpertKits, loadKnowledgeBases, loadSkills } from './api'
import type { DingTalkUser } from './auth'
import { loadEnterpriseCatalogCache, saveEnterpriseCatalogCache } from './enterpriseCache'
import { inspectInstalledExtensions, installExtension, mergeExpertKits, type ExpertKitView } from './expertKits'
import { synchronizePublishedExtensions } from './publishedExtensionSync'
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
  user: DingTalkUser | null
}) {
  const [expertKits, setExpertKits] = useState<ExpertKitView[]>([])
  const [expertKitCatalog, setExpertKitCatalog] = useState<ExpertKitCatalogEntry[]>([])
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [skillViews, setSkillViews] = useState<SkillView[]>([])
  const [connectors, setConnectors] = useState<ConnectorCatalogEntry[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [displayOwner, setDisplayOwner] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const cacheRef = useRef<CatalogData>(emptyCatalog())
  const catalogOwnerRef = useRef('')
  const inventoryRevisionRef = useRef(0)
  const cacheLoadedRef = useRef(false)
  const enabledConnectorIdsRef = useRef(enabledConnectorIds)

  const applyCatalog = useCallback((data = cacheRef.current) => {
    setDisplayOwner(catalogOwnerRef.current)
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
    if (!user) {
      cacheRef.current = emptyCatalog()
      catalogOwnerRef.current = ''
      cacheLoadedRef.current = false
      inventoryRevisionRef.current += 1
      setLoading(false)
      setError('')
      applyCatalog()
      return
    }
    if (catalogOwnerRef.current !== user.userId) {
      cacheRef.current = emptyCatalog()
      catalogOwnerRef.current = user.userId
      cacheLoadedRef.current = false
      inventoryRevisionRef.current += 1
      setError('')
      applyCatalog()
    }
    const controller = new AbortController()
    let syncing = false
    const synchronize = async (showLoading: boolean) => {
      if (syncing) return
      syncing = true
      if (showLoading) setLoading(true)
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
              connectors: [
                ...personal,
                ...cached.connectors.filter((item) => !isPersonalConnector(item) && !personal.some((value) => value.id === item.id)),
              ],
            }
            applyCatalog()
          }
        }
        if (!bootstrap) {
          const inventory = await inspectInstalledExtensions().catch(() => undefined)
          if (controller.signal.aborted || catalogOwnerRef.current !== user.userId) return
          if (inventory) cacheRef.current.installed = inventory.installed
          applyCatalog()
          const hasCache = cacheRef.current.catalog.length + cacheRef.current.skills.length + cacheRef.current.connectors.length + cacheRef.current.knowledge.length > 0
          setError(hasCache
            ? '企业服务未连接，正在显示本机缓存和已安装扩展。'
            : '企业服务未连接，企业能力目录暂不可用；已安装的本机扩展仍可查看。')
          return
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
        let latestInventory = installedResult.status === 'fulfilled' ? installedResult.value : undefined
        if (latestInventory && !currentInventory) {
          // A local install landed while the catalog was loading, so this snapshot is already stale:
          // read the inventory again instead of skipping the published-content sync for a whole cycle.
          const revision = inventoryRevisionRef.current
          latestInventory = await inspectInstalledExtensions().catch(() => undefined)
          if (controller.signal.aborted || catalogOwnerRef.current !== user.userId) return
          if (revision !== inventoryRevisionRef.current) latestInventory = undefined
        }
        const syncFailures: string[] = []
        if (latestInventory) {
          data.installed = latestInventory.installed
          const synchronized: InstalledExpertKit[] = await synchronizePublishedExtensions(
            catalogResult.status === 'fulfilled' ? catalogResult.value : [],
            skillsResult.status === 'fulfilled' ? skillsResult.value : [],
            latestInventory,
            {
              download: (kind, id) => kind === 'expert-kit'
                ? createExpertKitDownload(bootstrap.endpoints.expertKits, id, user.userId, accessToken)
                : createSkillDownload(bootstrap.endpoints.skills, id, user.userId, accessToken),
              install: (kind, download) => installExtension(download, kind),
              onFailure: (kind, id) => syncFailures.push(`${kind === 'expert-kit' ? '专家套件' : '技能'}「${id}」更新失败`),
            },
          )
          if (controller.signal.aborted || catalogOwnerRef.current !== user.userId) return
          data.installed = synchronized
        }
        if (skillsResult.status === 'fulfilled') data.skills = skillsResult.value
        if (connectorsResult.status === 'fulfilled') {
          const personal = loadPersonalConnectors(user.userId)
          data.connectors = [
            ...personal,
            ...connectorsResult.value.filter((item) => !personal.some((value) => value.id === item.id)),
          ]
        } else {
          const personal = loadPersonalConnectors(user.userId)
          data.connectors = [
            ...personal,
            ...data.connectors.filter((item) => !isPersonalConnector(item) && !personal.some((value) => value.id === item.id)),
          ]
        }
        if (knowledgeResult.status === 'fulfilled') data.knowledge = knowledgeResult.value
        applyCatalog()
        const remoteResults = [catalogResult, skillsResult, connectorsResult, knowledgeResult]
        const failures = remoteResults.flatMap((result, index) => result.status === 'rejected'
          ? [['专家套件', '技能', '连接器', '知识库'][index]] : [])
        const syncMessage = syncFailures.length ? `${syncFailures.join('；')}，将自动重试；当前继续使用已安装版本。` : ''
        setError(failures.length
          ? `${failures.join('、')}同步失败，正在显示最近一次可用内容。${syncMessage ? ` ${syncMessage}` : ''}`
          : installedResult.status === 'rejected' ? '本机扩展读取失败，企业目录仍可浏览。' : syncMessage)
        if (remoteResults.every((result) => result.status === 'fulfilled')) {
          void saveEnterpriseCatalogCache(user.userId, {
            savedAt: new Date().toISOString(), catalog: data.catalog, skills: data.skills, connectors: data.connectors.filter((item) => !isPersonalConnector(item)), knowledge: data.knowledge,
          }).catch(() => undefined)
        }
      } finally {
        syncing = false
        if (showLoading && !controller.signal.aborted) setLoading(false)
      }
    }
    void synchronize(true)
    const timer = bootstrap ? window.setInterval(() => void synchronize(false), 60_000) : undefined
    const onFocus = () => { void synchronize(false) }
    if (bootstrap) window.addEventListener('focus', onFocus)
    return () => { if (timer) window.clearInterval(timer); window.removeEventListener('focus', onFocus); controller.abort() }
  }, [accessToken, applyCatalog, bootstrap, refreshKey, user])

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  const refreshInstalled = useCallback(async () => {
    const owner = catalogOwnerRef.current
    const revision = ++inventoryRevisionRef.current
    const inventory = await inspectInstalledExtensions()
    if (owner !== catalogOwnerRef.current || revision !== inventoryRevisionRef.current) return inventory.installed
    cacheRef.current.installed = inventory.installed
    applyCatalog()
    return inventory.installed
  }, [applyCatalog])

  const replaceConnectors = useCallback((next: ConnectorCatalogEntry[] | ((current: ConnectorCatalogEntry[]) => ConnectorCatalogEntry[])) => {
    cacheRef.current.connectors = typeof next === 'function' ? next(cacheRef.current.connectors) : next
    applyCatalog()
  }, [applyCatalog])

  const visible = Boolean(user && displayOwner === user.userId)
  return {
    connectors: visible ? connectors : [],
    expertKitCatalog: visible ? expertKitCatalog : [],
    expertKits: visible ? expertKits : [],
    knowledgeBases: visible ? knowledgeBases : [],
    loading: visible && loading,
    error: visible ? error : '',
    refresh,
    refreshInstalled,
    replaceConnectors,
    skills: visible ? skills : [],
    skillViews: visible ? skillViews : [],
  }
}
