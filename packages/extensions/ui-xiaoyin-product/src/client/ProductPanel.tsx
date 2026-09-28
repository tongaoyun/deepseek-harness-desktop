import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useEffect, useState } from 'react'
import { en, NS, zh, type XiaoyinProductKey } from '../locales.ts'
import css from '../ProductPanel.module.css'

type ProductSession = { readonly authenticated?: boolean }
type ProductApi = {
  invoke(method: string, payload?: unknown): Promise<unknown>
  getSession(): Promise<ProductSession>
}
type ProductWindow = { xiaoyin?: { product?: ProductApi } }
type ProductKey = 'expertKits' | 'skills' | 'connectors' | 'knowledge' | 'schedules' | 'im'
type ProductItem = { readonly id: string; readonly label: string; readonly description?: string }
type ProductCatalog = Partial<Record<ProductKey, readonly ProductItem[]>>

const METHODS = {
  expertKits: 'expertKits.list', skills: 'skills.list', connectors: 'connectors.list',
  knowledge: 'knowledge.bases.list', schedules: 'schedules.list', im: 'im.channels.list',
} as const

function items(value: unknown): readonly ProductItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : `${index}`
    const label = [record.name, record.title, record.displayName].find((value): value is string => typeof value === 'string' && value.trim() !== '')
    if (label === undefined) return []
    const description = typeof record.description === 'string' ? record.description : undefined
    return [{ id, label, ...(description === undefined ? {} : { description }) }]
  })
}

export function ProductPanel(props: PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS>) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ProductCatalog>({})
  const [selected, setSelected] = useState<ProductKey>('expertKits')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const t = props.t
  const refresh = async (): Promise<void> => {
    const api = (globalThis as ProductWindow).xiaoyin?.product
    if (api === undefined) { setError(t('unavailable')); return }
    setLoading(true); setError(undefined)
    try {
      const session = await api.getSession()
      if (session.authenticated !== true) {
        setAuthRequired(true)
        setCatalog({})
        return
      }
      setAuthRequired(false)
      const next: ProductCatalog = {}
      for (const [key, method] of Object.entries(METHODS) as [ProductKey, string][]) next[key] = items(await api.invoke(method))
      setCatalog(next)
    } catch { setError(t('loadFailed')) }
    finally { setLoading(false) }
  }
  const signIn = async (): Promise<void> => {
    const api = (globalThis as ProductWindow).xiaoyin?.product
    if (api === undefined) { setError(t('unavailable')); return }
    setLoading(true); setError(undefined)
    try {
      await api.invoke('auth.ensureDingTalk')
      await refresh()
    } catch {
      setAuthRequired(true)
      setError(t('signInFailed'))
    } finally { setLoading(false) }
  }
  useEffect(() => { if (open) void refresh() }, [open])
  if (!open) return <button className={css.trigger} type="button" title={t('open')} onClick={() => { setOpen(true) }}>{t('title')}</button>
  const sections: [ProductKey, XiaoyinProductKey][] = [
    ['expertKits', 'expertKits'], ['skills', 'skills'], ['connectors', 'connectors'],
    ['knowledge', 'knowledge'], ['schedules', 'schedules'], ['im', 'im'],
  ]
  const selectedItems = catalog[selected] ?? []
  return <div className={css.panel} role="dialog" aria-label={t('title')}>
    <div className={css.header}><span>{t('title')}</span><div className={css.headerActions}><button className={css.refresh} type="button" onClick={() => { void refresh() }} aria-label={t('refresh')}>↻</button><button className={css.refresh} type="button" onClick={() => { setOpen(false) }} aria-label={t('close')}>×</button></div></div>
    {loading && <div>{t('loading')}</div>}
    {error !== undefined && <div className={css.error}>{error}</div>}
    {!loading && authRequired && <div className={css.auth}>
      <span>{t('authRequired')}</span>
      <button className={css.primary} type="button" onClick={() => { void signIn() }}>{t('signIn')}</button>
    </div>}
    {!loading && !authRequired && error === undefined && <>
      <div className={css.sections}>{sections.map(([key, label]) => <button className={`${css.section} ${selected === key ? css.selected : ''}`} type="button" key={key} onClick={() => { setSelected(key) }}><span>{t(label)}</span><span className={css.count}>{catalog[key]?.length ?? 0}</span></button>)}</div>
      <div className={css.list} aria-live="polite">{selectedItems.length === 0 ? <div className={css.empty}>{t('empty')}</div> : selectedItems.map(item => <div className={css.item} key={item.id}><strong>{item.label}</strong>{item.description !== undefined && <span>{item.description}</span>}</div>)}</div>
    </>}
  </div>
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xiaoyin-product: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'xiaoyin-product', order: 90, locale: NS }, ProductPanel))
}
