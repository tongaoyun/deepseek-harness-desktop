import type { PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconDownloadOutlineRegular, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { type Catalog, type ProductItem, type DeepSeekHarnessCatalogActions, type ProductDetail, type ProductReference, type CategoryFilter, type ConnectorFilter, METHODS, DESCRIPTION_KEYS, ICONS, AUTHORIZATION_TIMEOUT_MS, nextProductRequestId, items, detail, localizedMetadata, localizedCategory, itemMetadata, referenceDetails, normalizedSearch, classificationValue, groupLabel, localDetail, AvailabilityStatus, ConnectorStatus, isConnectorConnected, isInstalled, unavailableForUse, DetailIdentity } from './catalog-shared.tsx'
import { SkillDetailModal } from './SkillView.tsx'
import { ExpertKitDetailPage } from './ExpertKitView.tsx'
import { ConnectorDetailModal } from './ConnectorView.tsx'
import { KnowledgeDetail } from './KnowledgeView.tsx'
import { KnowledgeWorkspace } from './KnowledgeWorkspace.tsx'
import { isKnowledgeAccessDenied } from './knowledge-data.ts'
import { ExtensionPreview } from './ExtensionPreview.tsx'
import { ConnectorEditor } from './ConnectorEditor.tsx'
import { ExtensionImporter } from './ExtensionImporter.tsx'
import { EXTENSION_CATEGORIES, ExtensionImportDraftSchema, type ExtensionImportPreview } from '@deepseek-harness/product/extension-draft'
import { knowledgeReferenceDetails } from './catalog-shared.tsx'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceActionsMenu } from './ResourceActionsMenu.tsx'
export type { DeepSeekHarnessCatalogActions } from './catalog-shared.tsx'

type CatalogSectionProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & PropsRenderFactories & DeepSeekHarnessCatalogActions & {
  readonly catalog: Catalog
  readonly labelKey: DeepSeekHarnessProductKey
}

interface ReadScope {
  generation: number
  readonly requests: Map<string, ProductApi>
}

/** Main-panel content for one DeepSeekHarness product directory. */
export function DeepSeekHarnessCatalogSection(props: CatalogSectionProps): ReactNode {
  const { catalog, labelKey } = props
  const t = useCallback((key: DeepSeekHarnessProductKey): string => props.t(key), [props.t])
  const [entries, setEntries] = useState<readonly ProductItem[]>([])
  const [knowledgeRevision, setKnowledgeRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [authRequired, setAuthRequired] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [connectorFilter, setConnectorFilter] = useState<ConnectorFilter>('all')
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [selected, setSelected] = useState<ProductDetail>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [actionFailure, setActionFailure] = useState<string>()
  const [mine, setMine] = useState(false)
  const [editor, setEditor] = useState<{ imported?: ExtensionImportPreview; connector?: { id: string; version: string } }>()
  const [importer, setImporter] = useState(false)
  const [importMenu, setImportMenu] = useState(false)
  const [reference, setReference] = useState<{ kind: ProductReference['kind']; detail: ProductDetail }>()
  const [confirmation, setConfirmation] = useState<{ action: 'submit' | 'delete' | 'uninstall'; kind: 'skill' | 'expert-kit' | 'connector'; id: string; version: string; name: string }>()
  const [managementPending, setManagementPending] = useState(false)
  const [managementError, setManagementError] = useState<string>()
  const [installedSkills, setInstalledSkills] = useState<InstalledSkills>(new Map())
  const [installedExpertKits, setInstalledExpertKits] = useState<InstalledSkills>(new Map())
  const [installationsKnown, setInstallationsKnown] = useState(false)
  const catalogReads = useRef<ReadScope>({ generation: 0, requests: new Map() })
  const detailReads = useRef<ReadScope>({ generation: 0, requests: new Map() })
  const writes = useRef(new Map<string, ProductApi>())
  const managementLifetime = useRef(0)
  const employee = useRef<string | undefined>(undefined)
  const [identityRevision, setIdentityRevision] = useState(0)

  const cancelReads = (scope: ReadScope = detailReads.current): number => {
    scope.generation += 1
    for (const [requestId, api] of scope.requests) api.cancel(requestId)
    scope.requests.clear()
    return scope.generation
  }

  const synchronizeIdentity = (session: Awaited<ReturnType<ProductApi['getSession']>>): void => {
    const identity = session.authenticated === true ? session.employeeId ?? '' : undefined
    if (employee.current === identity) return
    employee.current = identity
    cancelReads()
    managementLifetime.current += 1
    for (const [requestId, api] of writes.current) api.cancel(requestId)
    writes.current.clear()
    setIdentityRevision(value => value + 1)
    setEntries([])
    setSelectedId(undefined); setSelected(undefined); setReference(undefined)
    setEditor(undefined); setImporter(false); setImportMenu(false); setConfirmation(undefined)
    setManagementPending(false); setManagementError(undefined)
    setActionPending(false); setActionFailure(undefined)
    setDetailLoading(false); setDetailError(false)
    setInstalledSkills(new Map()); setInstalledExpertKits(new Map()); setInstallationsKnown(false)
  }

  const read = async (api: ProductApi, method: string, payload?: unknown, timeoutMs?: number,
    scope: ReadScope = detailReads.current): Promise<unknown> => {
    const requestId = nextProductRequestId()
    scope.requests.set(requestId, api)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const request = api.invoke(method, payload, requestId)
      if (timeoutMs === undefined) return await request
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { api.cancel(requestId) }
          finally { reject(new Error('authorization request timed out')) }
        }, timeoutMs)
      })
      return await Promise.race([request, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      scope.requests.delete(requestId)
    }
  }

  const refresh = async (): Promise<void> => {
    const scope = catalogReads.current
    const currentGeneration = cancelReads(scope)
    const api = productApi()
    if (api === undefined) {
      setError(t('unavailable'))
      setLoading(false)
      return
    }
    setLoading(true)
    setError(undefined)
    setAuthError(false)
    try {
      const session = await api.getSession()
      if (currentGeneration !== scope.generation) return
      synchronizeIdentity(session)
      if (session.authenticated !== true) {
        setAuthRequired(true)
        setEntries([])
        return
      }
      setAuthRequired(false)
      if (currentGeneration !== scope.generation) return
      const catalogValue = await read(api, METHODS[catalog], undefined, undefined, scope)
      if (currentGeneration !== scope.generation) return
      if (catalog === 'skills') {
        const value = await props.readInstalledSkills?.()
        if (currentGeneration !== scope.generation) return
        setInstalledSkills(new Map(value?.installed.map(skill => [skill.id, skill]) ?? []))
        setInstallationsKnown(true)
      }
      if (catalog === 'expertKits') {
        const value = await props.readInstalledExpertKits?.()
        if (currentGeneration !== scope.generation) return
        setInstalledExpertKits(new Map(value?.installed.map(kit => [kit.id, kit]) ?? []))
        setInstallationsKnown(true)
      }
      if (currentGeneration !== scope.generation) return
      setEntries(items(catalogValue))
      if (catalog === 'knowledge') setKnowledgeRevision(value => value + 1)
    } catch (error: unknown) {
      if (currentGeneration !== scope.generation) return
      const session = await api.getSession().catch(() => undefined)
      if (currentGeneration !== scope.generation) return
      if (session !== undefined) synchronizeIdentity(session)
      if (session?.authenticated === false) {
        setAuthRequired(true)
        setEntries([])
        setError(undefined)
      } else {
        if (catalog === 'knowledge' && isKnowledgeAccessDenied(error)) setEntries([])
        setError(productErrorMessage(error, t, 'loadFailed'))
      }
    } finally {
      if (currentGeneration === scope.generation) setLoading(false)
    }
  }

  const signIn = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authPending) return
    setAuthPending(true)
    setAuthError(false)
    try {
      await read(api, 'auth.ensureDingTalk', undefined, AUTHORIZATION_TIMEOUT_MS)
      await refresh()
    } catch {
      setAuthError(true)
    } finally {
      setAuthPending(false)
    }
  }

  useEffect(() => {
    setQuery('')
    setCategoryFilter('all')
    setConnectorFilter('all')
    setMine(false)
    setEditor(undefined)
    setImporter(false)
    setCategoryMenuOpen(false)
    setSelectedId(undefined)
    setSelected(undefined)
    setInstallationsKnown(false)
    setConfirmation(undefined)
    setManagementPending(false)
    setManagementError(undefined)
    void refresh()
    return () => {
      cancelReads(catalogReads.current)
      cancelReads()
      managementLifetime.current += 1
      for (const [requestId, api] of writes.current) api.cancel(requestId)
      writes.current.clear()
    }
  }, [catalog])

  useEffect(() => {
    const api = productApi()
    if (api?.subscribe === undefined) return
    return api.subscribe((event) => {
      if (event.type === 'session.changed' && typeof event.payload === 'object' && event.payload !== null
        && 'authenticated' in event.payload && typeof event.payload.authenticated === 'boolean') {
        synchronizeIdentity({ authenticated: event.payload.authenticated,
          ...'employeeId' in event.payload && typeof event.payload.employeeId === 'string' ? { employeeId: event.payload.employeeId } : {} })
      }
      if (event.type === 'catalog.changed' || event.type === 'session.changed') void refresh()
    })
  }, [catalog])

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return entries.filter(entry => (needle === '' || normalizedSearch(entry).includes(needle))
      && (categoryFilter === 'all' || classificationValue(entry, catalog) === categoryFilter)
      && (!mine || entry.canEdit === true)
      && (catalog !== 'connectors' || connectorFilter === 'all'
        || isConnectorConnected(entry)))
  }, [catalog, categoryFilter, connectorFilter, entries, query, mine])

  const connectedCount = entries.filter(isConnectorConnected).length

  const classificationLabel = (value: string): string => catalog === 'knowledge'
    ? localizedMetadata(value, t)
    : localizedCategory(value, t)

  const categories = useMemo(() => {
    if (catalog === 'skills' || catalog === 'expertKits') return [...EXTENSION_CATEGORIES]
    return [...new Set(entries.map(entry => classificationValue(entry, catalog))
      .filter((value): value is string => value !== undefined))]
      .sort((left, right) => classificationLabel(left).localeCompare(classificationLabel(right)))
  }, [catalog, entries])

  useEffect(() => {
    if (categoryFilter !== 'all' && !categories.includes(categoryFilter)) setCategoryFilter('all')
  }, [categories, categoryFilter])

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, ProductItem[]>()
    for (const entry of filteredEntries) {
      const label = groupLabel(entry, catalog, t)
      const group = groups.get(label) ?? []
      group.push(entry)
      groups.set(label, group)
    }
    const values = [...groups.entries()]
    return catalog === 'expertKits' || catalog === 'skills'
      ? values.sort(([left], [right]) => categories.findIndex(value => classificationLabel(value) === left)
        - categories.findIndex(value => classificationLabel(value) === right))
      : values
  }, [catalog, filteredEntries])

  const closeDetail = (): void => {
    cancelReads()
    setSelectedId(undefined)
    setSelected(undefined)
    setDetailLoading(false)
    setDetailError(false)
    setActionFailure(undefined)
  }

  useEffect(() => {
    if (selectedId === undefined) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (event.key === 'Escape' && !event.defaultPrevented
        && (dialogs.length === 0 || (catalog === 'knowledge' && dialogs.length === 1))) closeDetail()
    }
    globalThis.addEventListener('keydown', closeOnEscape)
    return () => { globalThis.removeEventListener('keydown', closeOnEscape) }
  }, [selectedId, catalog])

  const openDetail = async (id: string): Promise<void> => {
    const api = productApi()
    if (api === undefined) return
    cancelReads()
    setSelectedId(id)
    setSelected(undefined)
    setDetailLoading(true)
    setDetailError(false)
    setActionFailure(undefined)
    const currentGeneration = detailReads.current.generation
    if (catalog !== 'expertKits' && catalog !== 'skills') {
      const entry = entries.find(candidate => candidate.id === id)
      if (entry !== undefined) setSelected(localDetail(entry))
      setDetailLoading(false)
      return
    }
    try {
      const prefix = catalog === 'expertKits' ? 'expertKits' : 'skills'
      const [metadata, readme, connectors] = await Promise.allSettled([
        read(api, `${prefix}.get`, { id }), read(api, `${prefix}.readme`, { id }),
        catalog === 'expertKits' ? read(api, 'connectors.list') : Promise.resolve([]),
      ] as const)
      if (currentGeneration !== detailReads.current.generation) return
      if (metadata.status === 'rejected') throw metadata.reason
      const parsed = detail(metadata.value, readme.status === 'fulfilled' ? readme.value : undefined)
      if (parsed === undefined) throw new Error('invalid product detail')
      const knowledgeBases = await Promise.allSettled([catalog === 'expertKits' && parsed.knowledgeBaseRefs.length > 0
        ? read(api, 'knowledge.references.resolve', { references: parsed.knowledgeBaseRefs }) : Promise.resolve([])])
      if (currentGeneration !== detailReads.current.generation) return
      const availabilityStatus = entries.find(entry => entry.id === id)?.availabilityStatus
      const withReferences = catalog === 'expertKits' ? {
        ...parsed,
        connectorDetails: referenceDetails(parsed.connectorRefs,
          connectors.status === 'fulfilled' ? connectors.value : [], 'connectors', connectors.status === 'rejected'),
        knowledgeBaseDetails: knowledgeReferenceDetails(parsed.knowledgeBaseRefs,
          knowledgeBases[0].status === 'fulfilled' ? knowledgeBases[0].value : [], knowledgeBases[0].status === 'rejected'),
      } : parsed
      setSelected(availabilityStatus === undefined ? withReferences : { ...withReferences, availabilityStatus })
    } catch {
      if (currentGeneration !== detailReads.current.generation) return
      setDetailError(true)
    } finally {
      if (currentGeneration === detailReads.current.generation) setDetailLoading(false)
    }
  }

  const useProduct = async (product: Pick<ProductDetail, 'id' | 'version' | 'sha256'>): Promise<void> => {
    const lifetime = managementLifetime.current
    setActionPending(true)
    setActionFailure(undefined)
    try {
      if (catalog === 'skills') {
        await props.installSkill(product.id)
        if (lifetime === managementLifetime.current) await rememberInstallation(product, lifetime)
      }
      else if (catalog === 'expertKits') {
        await props.startExpertKit(product.id)
      }
    } catch (error) {
      if (lifetime !== managementLifetime.current) return
      setActionFailure(productErrorMessage(error, t, catalog === 'skills' ? 'installFailed' : 'useFailed'))
    } finally {
      if (lifetime === managementLifetime.current) setActionPending(false)
    }
  }

  const rememberInstallation = async (
    skill: { id: string; version?: string; sha256?: string }, lifetime = managementLifetime.current,
  ): Promise<void> => {
    const value = await props.readInstalledSkills?.()
    if (lifetime !== managementLifetime.current) return
    setInstalledSkills(previous => value === undefined
      ? new Map([...previous, [skill.id, skill]]) : new Map(value.installed.map(entry => [entry.id, entry])))
  }
  const rememberKitInstallation = async (
    kit: { id: string; version?: string; sha256?: string }, lifetime = managementLifetime.current,
  ): Promise<void> => {
    const value = await props.readInstalledExpertKits?.()
    if (lifetime !== managementLifetime.current) return
    setInstalledExpertKits(previous => value === undefined
      ? new Map([...previous, [kit.id, kit]]) : new Map(value.installed.map(entry => [entry.id, entry])))
  }
  const installKit = async (kit: { id: string; version?: string; sha256?: string }): Promise<void> => {
    const lifetime = managementLifetime.current
    setActionPending(true); setActionFailure(undefined)
    try {
      if (!props.installExpertKit) throw new Error(t('unavailable'))
      await props.installExpertKit(kit.id)
      if (lifetime === managementLifetime.current) await rememberKitInstallation(kit, lifetime)
    } catch (error) { if (lifetime === managementLifetime.current) setActionFailure(productErrorMessage(error, t, 'installFailed')) }
    finally { if (lifetime === managementLifetime.current) setActionPending(false) }
  }

  const inspectImport = async (source: 'directory' | 'zip' | 'catalog', entry?: Pick<ProductItem, 'id'>): Promise<void> => {
    const api = productApi()
    if (!api || (catalog !== 'skills' && catalog !== 'expertKits')) return
    const lifetime = managementLifetime.current
    setImportMenu(false); setActionPending(true); setActionFailure(undefined)
    try {
      const result = await read(api, 'extensions.import.inspect', { kind: catalog === 'skills' ? 'skill' : 'expert-kit', source,
        ...(entry ? { id: entry.id } : {}) })
      if (lifetime !== managementLifetime.current) return
      if (typeof result !== 'object' || result === null || !('stageId' in result) || !('draft' in result)) return
      if (typeof result.stageId !== 'string' || !('files' in result) || !Array.isArray(result.files)) throw new Error(t('detailFailed'))
      const imported = { stageId: result.stageId, draft: ExtensionImportDraftSchema.parse(result.draft),
        files: result.files as ExtensionImportPreview['files'], missingFields: 'missingFields' in result && Array.isArray(result.missingFields)
          ? result.missingFields.filter((value): value is string => typeof value === 'string') : [] }
      if (source === 'catalog') await startAuthoring(imported, true)
      else setEditor({ imported })
    } catch (error) { if (lifetime === managementLifetime.current) setActionFailure(productErrorMessage(error, t, 'loadFailed')) }
    finally { if (lifetime === managementLifetime.current) setActionPending(false) }
  }

  const startAuthoring = async (imported?: ExtensionImportPreview, edit = false): Promise<void> => {
    if (catalog !== 'skills' && catalog !== 'expertKits') return
    if (!props.startExtensionAuthoring) throw new Error(t('unavailable'))
    const lifetime = managementLifetime.current
    const kind = catalog === 'skills' ? 'skill' : 'expert-kit'
    let prompt = t(imported ? 'completeExtensionPrompt' : kind === 'skill' ? 'createSkillPrompt' : 'createKitPrompt')
    if (edit) {
      const name = imported?.draft.name
      if (!name) throw new Error(t('detailFailed'))
      prompt = t(kind === 'skill' ? 'modifySkillPrompt' : 'modifyKitPrompt').replace('{name}', () => name)
    }
    await props.startExtensionAuthoring(kind, {
      prompt,
      ...imported ? { stageId: imported.stageId, edit } : {},
    })
    if (lifetime !== managementLifetime.current) return
    if (imported) void productApi()?.invoke('extensions.import.release', { stageId: imported.stageId }, nextProductRequestId()).catch(() => undefined)
    setEditor(undefined)
  }
  const createContent = async (): Promise<void> => {
    const lifetime = managementLifetime.current
    setActionPending(true); setActionFailure(undefined)
    try { await startAuthoring() }
    catch (error) { if (lifetime === managementLifetime.current) setActionFailure(productErrorMessage(error, t, 'loadFailed')) }
    finally { if (lifetime === managementLifetime.current) setActionPending(false) }
  }

  const editResource = (entry: ProductItem | ProductDetail): void => {
    if (catalog === 'connectors') {
      if (!entry.version) return
      closeDetail(); setEditor({ connector: { id: entry.id, version: entry.version } })
    } else void inspectImport('catalog', entry)
  }
  const confirmManagement = (action: 'submit' | 'delete' | 'uninstall', entry: ProductItem | ProductDetail): void => {
    const installations = catalog === 'skills' ? installedSkills : installedExpertKits
    const version = action === 'uninstall' ? installations.get(entry.id)?.version : entry.version
    if (!version || (action === 'submit' ? !entry.canSubmit : action === 'delete' ? !entry.canDelete
      : catalog !== 'expertKits' && catalog !== 'skills')) return
    setManagementError(undefined)
    setConfirmation({ action, kind: catalog === 'skills' ? 'skill' : catalog === 'expertKits' ? 'expert-kit' : 'connector',
      id: entry.id, version, name: 'label' in entry ? entry.label : entry.name })
  }
  const manageResource = async (): Promise<void> => {
    const api = productApi()
    if (!api || !confirmation || managementPending) return
    const target = confirmation
    const lifetime = managementLifetime.current
    const requestId = nextProductRequestId()
    writes.current.set(requestId, api)
    setManagementPending(true); setManagementError(undefined)
    try {
      const method = target.action === 'uninstall' ? target.kind === 'skill' ? 'skills.uninstall' : 'expertKits.uninstall'
        : target.action === 'submit' ? 'extensions.submit'
          : target.kind === 'connector' ? 'extensions.connector.delete' : 'extensions.delete'
      await api.invoke(method, { kind: target.kind, id: target.id, version: target.version }, requestId)
      if (lifetime !== managementLifetime.current) return
      setConfirmation(undefined)
      if (target.action === 'delete') {
        closeDetail()
        setEntries(previous => previous.filter(entry => entry.id !== target.id))
      } else if (target.action === 'uninstall') {
        const setInstallations = target.kind === 'skill' ? setInstalledSkills : setInstalledExpertKits
        setInstallations((previous) => {
          const remaining = new Map(previous)
          remaining.delete(target.id)
          return remaining
        })
      } else {
        setSelected(previous => previous?.id === target.id ? { ...previous, canSubmit: false, reviewStatus: 'SUBMITTED' } : previous)
      }
      await refresh()
    } catch (error) {
      if (lifetime === managementLifetime.current) setManagementError(productErrorMessage(error, t,
        target.action === 'uninstall' ? 'resourceUninstallFailed' : target.action === 'delete' ? 'deleteFailed' : 'saveFailed'))
    } finally {
      writes.current.delete(requestId)
      if (lifetime === managementLifetime.current) setManagementPending(false)
    }
  }
  const managementActions = (resource: ProductItem | ProductDetail): ReactNode => <ResourceActionsMenu resource={resource}
    pending={actionPending || managementPending} onEdit={() => { editResource(resource) }}
    onSubmit={() => { confirmManagement('submit', resource) }} onDelete={() => { confirmManagement('delete', resource) }}
    {...((catalog === 'expertKits' && installedExpertKits.has(resource.id)) || (catalog === 'skills' && installedSkills.has(resource.id)))
      ? { onUninstall: () => { confirmManagement('uninstall', resource) } } : {}} t={t} />
  const managementModal = <Modal open={confirmation !== undefined} onClose={() => { if (!managementPending) setConfirmation(undefined) }}
    title={confirmation?.action === 'uninstall' ? t('resourceUninstallTitle').replace('{name}', confirmation.name)
      : confirmation?.action === 'delete' ? t('resourceDeleteTitle').replace('{name}', confirmation.name) : t('submitResourceTitle')}
    closeLabel={t('close')} footer={<div className={css.detailActions}>
      <Button variant="outline" disabled={managementPending} onClick={() => { setConfirmation(undefined) }}>{t('cancel')}</Button>
      <Button variant="primary" className={confirmation?.action === 'delete' ? css.dangerButton : undefined} disabled={managementPending}
        onClick={() => { void manageResource() }}>{confirmation?.action === 'uninstall'
          ? t(managementPending ? 'uninstallingResource' : 'uninstallResource') : confirmation?.action === 'delete'
            ? t(managementPending ? 'deletingResource' : 'deleteResource') : t(managementPending ? 'submittingResource' : 'submitShared')}</Button>
    </div>}>
    <p>{confirmation?.action === 'uninstall' ? t(confirmation.kind === 'skill' ? 'skillUninstallConfirmation' : 'expertKitUninstallConfirmation')
      : confirmation?.action === 'delete' ? t('resourceDeleteConfirmation')
        : t('submitResourceConfirmation').replace('{name}', confirmation?.name ?? '')}</p>
    {confirmation?.action === 'delete' && confirmation.kind === 'connector' && <p>{t('connectorDeleteImpact')}</p>}
    {managementError && <p className={css.catalogError} role="alert">{managementError}</p>}
  </Modal>

  const openReference = async (value: ProductReference): Promise<void> => {
    const api = productApi()
    if (!api || !value.kind) return
    const lifetime = managementLifetime.current
    const currentGeneration = detailReads.current.generation
    try {
      if (value.kind === 'skills') {
        const skill = selected?.skillDetails.find(skill => skill.id === value.id)
        if (skill && selected) {
          const markdown = await read(api, 'extensions.bundledSkill.read', { id: selected.id, skillId: skill.id })
          if (lifetime !== managementLifetime.current || currentGeneration !== detailReads.current.generation) return
          const parsed = detail({ id: skill.id, name: skill.name, summary: skill.summary, version: selected.version }, markdown)
          if (parsed) setReference({ kind: 'skills', detail: parsed })
        }
      } else {
        const values = items(await read(api, METHODS[value.kind]))
        if (lifetime !== managementLifetime.current || currentGeneration !== detailReads.current.generation) return
        const item = values.find(entry => entry.id === value.id)
        if (!item) throw new Error(t('referenceUnauthorized'))
        setReference({ kind: value.kind, detail: localDetail(item) })
      }
    } catch (error) { if (lifetime === managementLifetime.current && currentGeneration === detailReads.current.generation) setActionFailure(productErrorMessage(error, t, 'detailFailed')) }
  }
  const referenceModal = reference?.kind === 'connectors' ? <ConnectorDetailModal open detail={reference.detail} loading={false} error={false}
    onClose={() => { setReference(undefined) }} onCatalogChanged={() => refresh()} t={t} />
    : reference?.kind === 'skills' ? <SkillDetailModal open bundled detail={reference.detail}
      loading={false} error={false} installed={false}
      installationsKnown={false} actionPending={false}
      onClose={() => { setReference(undefined) }} onUse={() => undefined} t={t} />
      : reference?.kind === 'knowledge' ? <div className={css.drawerBackdrop} onMouseDown={(event) => {
        if (event.target === event.currentTarget) setReference(undefined)
      }}><aside className={`${css.detailDrawer} ${css.knowledgeDrawer}`} role="dialog" aria-modal="true" aria-label={reference.detail.name}>
          <div className={css.drawerBar}><span>{t('details')}</span><button type="button" className={css.iconButton} aria-label={t('close')}
            onClick={() => { setReference(undefined) }}><IconCloseOutlineRegular size={16} /></button></div>
          <article className={css.detailContent}><DetailIdentity detail={reference.detail} icon={IconDatabaseOutlineRegular}
            showVisibility={false} t={t} />
          <KnowledgeDetail product={reference.detail} renderFactorySlot={props.renderFactorySlot} t={t} /></article></aside></div> : null

  const Icon = ICONS[catalog]
  const showCatalogControls = loading || (!authRequired && error === undefined)
  const categoryItems = [
    { id: 'all', label: t('allCategories') },
    ...categories.map(category => ({ id: category, label: classificationLabel(category) })),
  ]
  const selectedCategoryLabel = categoryFilter === 'all'
    ? t('allCategories')
    : classificationLabel(categoryFilter)

  if (catalog === 'knowledge') return <KnowledgeWorkspace key={identityRevision} entries={entries} loading={loading} refreshRevision={knowledgeRevision}
    {...error === undefined ? {} : { error }}
    renderFactorySlot={props.renderFactorySlot}
    authRequired={authRequired} authPending={authPending} authError={authError} t={t}
    onRefresh={() => { void refresh() }} onSignIn={() => { void signIn() }} />

  if (catalog === 'expertKits' && selectedId !== undefined) {
    return <section className={css.catalogPage} aria-label={selected?.name ?? t(labelKey)}>
      <div className={css.catalogScroll}>
        <div className={css.catalogContent}>
          {detailLoading && <p className={css.catalogStatus} role="status">{t('loading')}</p>}
          {!detailLoading && detailError && <div className={css.detailPageError}>
            <button className={css.backButton} type="button" onClick={closeDetail}>
              <IconChevronLeftOutlineRegular size={16} />{t('backToCatalog')}
            </button>
            <p className={css.catalogError} role="alert">{t('detailFailed')}</p>
          </div>}
          {selected !== undefined && <ExpertKitDetailPage detail={selected} actionPending={actionPending}
            installed={isInstalled(installedExpertKits, selected)} installationsKnown={installationsKnown}
            onInstall={() => { void installKit(selected) }}
            managementActions={managementActions(selected)}
            actionError={actionFailure} onBack={closeDetail} onOpen={(value) => { void openReference(value) }}
            onUse={() => { void useProduct(selected) }} t={t} />}
          {referenceModal}
          {managementModal}
        </div>
      </div>
    </section>
  }

  return <section className={css.catalogPage} aria-label={t(labelKey)}>
    <div className={css.catalogScroll}>
      <div className={css.catalogContent}>
        <header className={css.catalogHeader}>
          <div><h1 className={css.catalogTitle}>{t(labelKey)}</h1>
            <p className={css.catalogDescription}>{t(DESCRIPTION_KEYS[catalog])}</p></div>
          {!authRequired && <div className={css.catalogHeaderActions}>
            {catalog === 'connectors' ? <Button variant="primary" size="sm" disabled={actionPending}
              onClick={() => { setEditor({}) }}><IconPlusOutlineRegular size={16} />{t('addExtension')}</Button>
              : <Menu open={importMenu} items={[
                { id: 'create', label: t(catalog === 'skills' ? 'createSkill' : 'createExpertKit') },
                { id: 'import', label: t(catalog === 'skills' ? 'importSkill' : 'importExpertKit') }]}
              onClose={() => { setImportMenu(false) }} onSelect={(id) => {
                setImportMenu(false)
                if (id === 'import') setImporter(true)
                else void createContent()
              }} portal align="end" anchor={<Button variant="primary" size="sm" disabled={actionPending}
                onClick={() => { setImportMenu(value => !value) }}><IconPlusOutlineRegular size={16} />{t('addExtension')}
                <IconChevronDownOutlineRegular size={14} /></Button>} />}
          </div>}
        </header>
        {(catalog === 'skills' || catalog === 'expertKits') && !authRequired && <div className={css.catalogTabs} role="tablist" aria-label={t(labelKey)}>
          {[false, true].map(value => <button key={String(value)} type="button" role="tab" aria-selected={mine === value}
            onClick={() => { setMine(value) }}>{t(value ? 'mineExtensions' : 'connectorFilterAll')}</button>)}
        </div>}
        {actionFailure && (catalog !== 'skills' || selectedId === undefined)
          && <p className={css.catalogError} role="alert">{actionFailure}</p>}
        {catalog === 'connectors' && !authRequired && error === undefined && <div className={css.catalogTabs}
          role="tablist" aria-label={t('connectorFilter')}>
          {(['all', 'connected', 'mine'] as const).map((id, index, tabs) => <button key={id} type="button" role="tab"
            id={`product-connectors-tab-${id}`} aria-selected={mine ? id === 'mine' : connectorFilter === id}
            aria-controls="deepseek-harness-catalog-results" tabIndex={(mine ? id === 'mine' : connectorFilter === id) ? 0 : -1}
            onClick={() => { setMine(id === 'mine'); setConnectorFilter(id === 'connected' ? 'connected' : 'all') }} onKeyDown={(event) => {
              const next = event.key === 'Home' ? 'all' : event.key === 'End' ? 'mine'
                : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length]
                  : event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : undefined
              if (next === undefined) return
              event.preventDefault()
              setMine(next === 'mine')
              setConnectorFilter(next === 'connected' ? 'connected' : 'all')
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#product-connectors-tab-${next}`)?.focus()
            }}>
            {t(id === 'all' ? 'connectorFilterAll' : id === 'mine' ? 'mineExtensions' : 'connectorFilterConnected')}
            {id === 'connected' && <span className={css.tabCount}>{connectedCount}</span>}
          </button>)}
        </div>}
        {showCatalogControls && <div className={css.catalogToolbar}>
          <label className={css.searchField}>
            <IconSearchOutlineRegular size={16} />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input value={query} onChange={(event) => { setQuery(event.currentTarget.value) }}
              placeholder={t('searchPlaceholder')} type="search" />
          </label>
          {categories.length > 0 && <Menu open={categoryMenuOpen} items={categoryItems}
            selectedId={categoryFilter} portal align="end" compact className={css.categoryMenu}
            listClassName={css.categoryMenuList}
            onSelect={(id) => { setCategoryFilter(id); setCategoryMenuOpen(false) }}
            onClose={() => { setCategoryMenuOpen(false) }}
            anchor={<button className={css.categoryButton} type="button" aria-label={t('categoryFilter')}
              aria-expanded={categoryMenuOpen} onClick={() => { setCategoryMenuOpen(value => !value) }}>
              <span>{selectedCategoryLabel}</span><IconChevronDownOutlineRegular size={14} />
            </button>} />}
          <Tooltip portal label={t('refresh')} side="bottom" delayMs={500}>
            <button className={css.iconButton} type="button" disabled={loading} aria-label={t('refresh')}
              onClick={() => { void refresh() }}><IconRefreshOutlineRegular size={16} /></button>
          </Tooltip>
        </div>}
        {!loading && error === undefined && !authRequired && <div className={css.resultSummary}>
          {t('itemCount').replace('{count}', String(filteredEntries.length))}
        </div>}
        <div id="deepseek-harness-catalog-results" role={catalog === 'connectors' ? 'tabpanel' : undefined}
          aria-labelledby={catalog === 'connectors' ? `product-connectors-tab-${connectorFilter}` : undefined}>
          {loading && <p className={css.catalogStatus} role="status">{t('loading')}</p>}
          {!loading && authRequired && <div className={css.authEmptyState} role="status" aria-live="polite">
            <span className={css.authEmptyIcon} aria-hidden="true"><Icon size={22} /></span>
            <div className={css.authEmptyCopy}>
              <strong>{authPending ? t('authWaiting') : authError ? t('authFailedTitle') : t('authTitle')}</strong>
              <span>{t('authRequired')}</span>
              {authError && <span className={css.catalogError} role="alert">{t('signInFailed')}</span>}
            </div>
            <Button className={css.authAction} variant="primary" size="sm" disabled={authPending}
              aria-busy={authPending} onClick={() => { void signIn() }}>
              {authPending ? t('signingIn') : t('signIn')}
            </Button>
          </div>}
          {!loading && error !== undefined && <p className={css.catalogError} role="alert">{error}</p>}
          {!loading && error === undefined && !authRequired && (filteredEntries.length === 0
            ? <p className={css.catalogStatus}>{query !== '' ? t('noSearchResults')
              : catalog === 'connectors' && connectorFilter === 'connected' ? t('noConnectedConnectors') : t('empty')}</p>
            : groupedEntries.map(([group, groupItems]) => <section className={css.catalogGroup}
              aria-label={group === '' ? undefined : group} key={group || 'all'}>
              {group !== '' && <h2 className={css.groupTitle}>{group}<span>{groupItems.length}</span></h2>}
              <CatalogItems entries={groupItems} catalog={catalog} detailLoading={detailLoading}
                installedSkills={catalog === 'expertKits' ? installedExpertKits : installedSkills} installationsKnown={installationsKnown}
                managementActions={managementActions}
                onOpen={(id) => { void openDetail(id) }} onUseSkill={(entry) => {
                  if (catalog === 'expertKits') void installKit(entry)
                  else void useProduct(entry)
                }} actionPending={actionPending} t={t} />
            </section>))}
        </div>
      </div>
    </div>
    {catalog === 'skills' && <SkillDetailModal open={selectedId !== undefined} detail={selected}
      installed={selected !== undefined && isInstalled(installedSkills, selected)} installationsKnown={installationsKnown}
      loading={detailLoading} error={detailError} actionPending={actionPending}
      actionFailure={actionFailure} managementActions={selected ? managementActions(selected) : undefined}
      onClose={closeDetail} onUse={() => { if (selected !== undefined) void useProduct(selected) }} t={t} />}
    {catalog === 'connectors' && <ConnectorDetailModal open={selectedId !== undefined} detail={selected}
      loading={detailLoading} error={detailError} onClose={closeDetail}
      managementActions={selected ? managementActions(selected) : undefined}
      onCatalogChanged={() => { closeDetail(); return refresh() }} t={t} />}
    {importer && (catalog === 'skills' || catalog === 'expertKits') && <ExtensionImporter kind={catalog === 'skills' ? 'skill' : 'expert-kit'}
      onClose={() => { setImporter(false) }} onInspected={(imported) => { setImporter(false); setEditor({ imported }) }} t={t} />}
    {editor?.imported && <ExtensionPreview preview={editor.imported} onClose={() => { setEditor(undefined) }}
      onContinue={() => startAuthoring(editor.imported)}
      onSaved={() => { setEditor(undefined); setMine(true); void refresh() }} t={t} />}
    {editor && catalog === 'connectors' && <ConnectorEditor
      editing={editor.connector}
      onClose={() => { setEditor(undefined) }} onSaved={() => { setEditor(undefined); setMine(true); void refresh() }} t={t} />}
    {managementModal}
  </section>
}

function CatalogItemCopy({ catalog, entry, t }: {
  readonly catalog: Catalog
  readonly entry: ProductItem
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const metadata = itemMetadata(entry, catalog, t)
  return <span className={css.catalogItemCopy}>
    <span className={css.itemTitle}>{entry.label}</span>
    {entry.description !== undefined && <span className={css.itemDescription}>{entry.description}</span>}
    {metadata.length > 0 && <span className={css.itemMetadata}>{metadata.map(value =>
      <span key={value}>{value}</span>)}</span>}
  </span>
}

type InstalledSkills = ReadonlyMap<string, { readonly version?: string; readonly sha256?: string }>

function CatalogItems({
  actionPending, catalog, detailLoading, entries, installedSkills, installationsKnown, onOpen, onUseSkill, managementActions, t,
}: {
  readonly actionPending: boolean
  readonly catalog: Catalog
  readonly detailLoading: boolean
  readonly entries: readonly ProductItem[]
  readonly installedSkills: InstalledSkills
  readonly installationsKnown: boolean
  readonly onOpen: (id: string) => void
  readonly onUseSkill: (entry: ProductItem) => void
  readonly managementActions: (entry: ProductItem) => ReactNode
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const Icon = ICONS[catalog]
  return <ul className={catalog === 'knowledge' ? css.catalogList : css.catalogGrid}
    data-catalog={catalog}>{entries.map((entry) => {
      const disabled = detailLoading || actionPending
      const installed = isInstalled(installedSkills, entry)
      const actionDisabled = disabled || (catalog === 'skills' || catalog === 'expertKits'
        ? !installationsKnown || installed || entry.availabilityStatus === 'INCOMPATIBLE'
        : unavailableForUse(entry.availabilityStatus))
      if (catalog === 'knowledge') return <li className={css.catalogRow} key={entry.id}>
        <span className={css.catalogArtwork} aria-hidden="true"><Icon size={20} /></span>
        <button className={css.catalogItem} type="button" disabled={disabled} onClick={() => { onOpen(entry.id) }}>
          <CatalogItemCopy entry={entry} catalog={catalog} t={t} />
          <IconChevronRightOutlineRegular size={16} />
        </button>
      </li>
      const metadata = itemMetadata(entry, catalog, t)
      return <li className={css.catalogCard} data-catalog={catalog} key={entry.id}>
        <button className={css.cardBody} type="button" disabled={disabled} onClick={() => { onOpen(entry.id) }}>
          <span className={css.cardIdentity}>
            <span className={css.catalogArtwork} aria-hidden="true"><Icon size={20} /></span>
            <span className={css.catalogItemCopy}>
              <span className={css.itemTitle} title={entry.label}>{entry.label}</span>
              {catalog !== 'connectors' && entry.author !== undefined
              && <span className={css.itemAuthor}>{entry.author}</span>}
              {catalog === 'connectors' && entry.description !== undefined
              && <span className={css.itemDescription}>{entry.description}</span>}
            </span>
            {catalog === 'connectors' && <ConnectorStatus connector={entry} t={t} />}
          </span>
          {catalog !== 'connectors' && <span className={css.cardSummary}>{entry.description}</span>}
        </button>
        <div className={css.cardFooter}>
          <span className={css.cardFacts}>
            {catalog !== 'connectors' && entry.availabilityStatus !== 'AVAILABLE'
              && <AvailabilityStatus status={entry.availabilityStatus} t={t} />}
            {metadata.length > 0 && <span className={css.itemMetadata}>{metadata.map(value =>
              <span key={value}>{value}</span>)}</span>}
          </span>
          {(catalog === 'skills' || catalog === 'expertKits') && (installed
            ? <span className={css.cardInstalled}>{t(catalog === 'skills' ? 'skillInstalled' : 'expertKitInstalled')}</span>
            : <button className={css.cardAction} type="button"
              disabled={actionDisabled} onClick={() => { onUseSkill(entry) }}>
              <IconDownloadOutlineRegular size={14} />{t(catalog === 'skills' ? 'installSkill' : 'installExpertKit')}
            </button>)}
          {managementActions(entry)}
        </div>
      </li>
    })}</ul>
}

/** Official main-slot panel for the Expert Kits directory. */
export function ExpertKitsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="expertKits" labelKey="expertKits" />
}

/** Official main-slot panel for the Skills directory. */
export function SkillsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="skills" labelKey="skills" />
}

/** Official main-slot panel for the Connectors directory. */
export function ConnectorsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="connectors" labelKey="connectors" />
}

/** Official main-slot panel for the Knowledge directory. */
export function KnowledgePanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="knowledge" labelKey="knowledge" />
}
