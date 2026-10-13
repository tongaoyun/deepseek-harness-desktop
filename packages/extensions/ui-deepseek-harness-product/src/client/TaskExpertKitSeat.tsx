/** Expert Kit selection complements the official execution-mode surfaces. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, IconSparkleRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NS } from '../locales.ts'
import type { TaskModeActions } from './harness-actions.ts'
import { unavailableForUse, type ProductItem } from './catalog-shared.tsx'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'

type KitInjected = Pick<TaskModeActions,
  'readMode' | 'readExpertKits' | 'setExpertKit' | 'recoverCapabilities' | 'retryCapabilities' | 'openCatalog'>
type KitProps = PropsRuntime<'conversation.hero.actions'> & PropsLocale<typeof NS> & InjectFace<KitInjected>
type KitHeaderProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>
  & InjectFace<Pick<TaskModeActions, 'readMode' | 'recoverCapabilities' | 'retryCapabilities'>>

/** Select an Expert Kit without replacing the official mode control.
 * @param props Public Session selectors, catalog access, and guarded task actions.
 * @returns The Kit selector and task preparation failures.
 */
export function TaskExpertKitSeat({
  sessionId, useSessions, readMode, readExpertKits, setExpertKit,
  recoverCapabilities, retryCapabilities, openCatalog, t,
}: KitProps) {
  const presetId = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.projectionValues?.agentPreset)
  const [state, setState] = useState<Awaited<ReturnType<TaskModeActions['readMode']>>>()
  const [kits, setKits] = useState<readonly ProductItem[]>()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState('')
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [catalogRevision, setCatalogRevision] = useState(0)
  useEffect(() => productApi()?.subscribe((event) => {
    if (event.type === 'catalog.changed') setCatalogRevision(value => value + 1)
    if (event.type === 'catalog.changed' || event.type === 'session.changed') setRevision(value => value + 1)
  }), [])
  useEffect(() => {
    setState(undefined)
    setOpen(false)
    setPending(false)
  }, [sessionId, presetId])
  useEffect(() => {
    let active = true
    setFailed('')
    void readMode(sessionId).then((value) => { if (active) setState(value) })
      .catch((error: unknown) => { if (active) setFailed(productErrorMessage(error, t, 'taskSelectionFailed')) })
    return () => { active = false }
  }, [readMode, sessionId, presetId, revision, t])
  useEffect(() => {
    if (!open) return
    let active = true
    const controller = new AbortController()
    setKits(undefined); setCatalogFailed(false)
    void readExpertKits(controller.signal).then((value) => { if (active) setKits(value) })
      .catch(() => { if (active) setCatalogFailed(true) })
    return () => { active = false; controller.abort() }
  }, [open, readExpertKits, catalogRevision])
  const kit = state?.capabilities.expertKit
  const refresh = () => { setRevision(value => value + 1) }
  const apply = (operation: Promise<void>) => {
    const captured = sessionId
    setPending(true); setFailed('')
    void operation.then(() => { if (activeSession.current === captured) refresh() })
      .catch((error: unknown) => { if (activeSession.current === captured) {
        setFailed(productErrorMessage(error, t, 'taskSelectionFailed'))
      } }).finally(() => { if (activeSession.current === captured) setPending(false) })
  }
  const kitEntries: MenuEntry[] = [
    { type: 'label', id: 'kits-heading', text: t('expertKits') },
    { id: 'kit:none', label: t('noExpertKit') },
    ...(kits ?? []).map(row => ({ id: `kit:${row.id}`, disabled: unavailableForUse(row.availabilityStatus ?? row.status),
      label: <span className={css.kitMenuItem}>{row.label}</span> })),
    ...kit !== undefined && kits !== undefined && !kits.some(row => row.id === kit.id)
      ? [{ id: `kit:${kit.id}`, label: kit.name ?? kit.id, disabled: true }] : [],
    ...(kits === undefined ? catalogFailed
      ? [{ id: 'kits:retry', label: t('retry') }] : [{ type: 'label' as const, id: 'kits-loading', text: t('loading') }] : []),
    { type: 'separator', id: 'directory-separator' },
    { id: 'kits:directory', label: t('expertKitDirectory') },
  ]
  return <div className={css.taskKitGroup}>
    <Menu className={css.taskSelector} open={open} portal align="start" onClose={() => { setOpen(false) }} items={kitEntries}
      selectedIds={[`kit:${kit?.id ?? 'none'}`]}
      onSelect={(id) => {
        if (id === 'kits:retry') { setCatalogRevision(value => value + 1); return }
        setOpen(false)
        if (id === 'kits:directory') { openCatalog('expertKits'); return }
        if (id === `kit:${kit?.id ?? 'none'}`) return
        apply(setExpertKit(id === 'kit:none' ? null : id.slice(4), sessionId))
      }} anchor={<button className={css.taskKitButton} type="button" aria-label={t('selectExpertKit')}
        aria-haspopup="menu" aria-expanded={open} disabled={pending || state === undefined}
        title={kit === undefined ? t('expertKits') : `${t('expertKits')}: ${kit.name ?? kit.id}`}
        onClick={() => { setOpen(value => !value) }}>
        <IconSparkleRegular size={16} />
        <span>{kit?.name ?? kit?.id ?? t('expertKits')}</span>
        <IconChevronDownOutlineRegular size={14} />
      </button>} />
    {state?.capabilities.unavailable !== undefined && <span role="alert" className={css.catalogError}>
      {productErrorMessage(state.capabilities.unavailable, t, 'taskSelectionFailed')}
      <button type="button" disabled={pending} onClick={() => {
        apply(state.capabilities.unavailable?.retryable ? retryCapabilities(sessionId) : recoverCapabilities(sessionId))
      }}>{t(state.capabilities.unavailable.retryable ? 'retry' : 'taskRecovery')}</button>
    </span>}
    {failed && <span role="alert" className={css.catalogError}>{failed}</span>}
  </div>
}

/** Display a started task's pinned Kit without offering composition changes.
 * @param props Session selectors, pinned task access, and explicit snapshot recovery.
 * @returns A read-only Kit label, with failures and recovery independent of the label.
 */
export function TaskExpertKitHeader({ sessionId, useSessions, readMode, recoverCapabilities, retryCapabilities, t }: KitHeaderProps) {
  const presetId = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const [view, setView] = useState<{
    sessionId: typeof sessionId
    presetId: typeof presetId
    state?: Awaited<ReturnType<TaskModeActions['readMode']>>
    error?: string
  }>()
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId
  useEffect(() => productApi()?.subscribe((event) => {
    if (event.type === 'catalog.changed' || event.type === 'session.changed') setRevision(value => value + 1)
  }), [])
  useEffect(() => { setPending(false) }, [sessionId, presetId])
  useEffect(() => {
    let active = true
    void readMode(sessionId).then((state) => { if (active) setView({ sessionId, presetId, state }) })
      .catch((error: unknown) => { if (active) setView({ sessionId, presetId,
        error: productErrorMessage(error, t, 'taskSelectionFailed') }) })
    return () => { active = false }
  }, [readMode, sessionId, presetId, revision, t])
  const current = view?.sessionId === sessionId && view.presetId === presetId ? view : undefined
  const kit = current?.state?.capabilities.expertKit
  const unavailable = current?.state?.capabilities.unavailable
  if (kit === undefined && unavailable === undefined && current?.error === undefined) return null
  return <div className={css.taskKitHeader}>
    {kit !== undefined && <span className={css.taskKitLabel} title={`${t('expertKits')}: ${kit.name ?? kit.id}`}>
      <IconSparkleRegular size={14} />
      <span>{kit.name ?? kit.id}</span>
    </span>}
    {unavailable !== undefined && <span role="alert" className={css.catalogError}>
      {productErrorMessage(unavailable, t, 'taskSelectionFailed')}
      <button type="button" disabled={pending} onClick={() => {
        const captured = sessionId
        setPending(true)
        setView((value) => {
          if (value === undefined) return value
          const { error: _error, ...retained } = value
          return retained
        })
        void (unavailable.retryable ? retryCapabilities(captured) : recoverCapabilities(captured)).then(() => {
          if (activeSession.current === captured) setRevision(value => value + 1)
        }).catch((error: unknown) => {
          if (activeSession.current === captured) setView(value => value === undefined ? value : {
            ...value, error: productErrorMessage(error, t, 'taskSelectionFailed'),
          })
        }).finally(() => { if (activeSession.current === captured) setPending(false) })
      }}>{t(unavailable.retryable ? 'retry' : 'taskRecovery')}</button>
    </span>}
    {current?.error !== undefined && <span role="alert" className={css.catalogError}>{current.error}</span>}
  </div>
}
