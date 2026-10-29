import type { ComponentType, ReactNode } from 'react'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { ProductCatalogSchema, type ProductCatalogItem, type ProductConnectorTool } from '@deepseek-harness/product/catalog'

export type Catalog = keyof typeof METHODS

export type ConnectorTool = ProductConnectorTool

export type ProductItem = ProductCatalogItem

export interface DeepSeekHarnessCatalogActions {
  readCapabilities?(this: void): Promise<ProductTaskCapabilities>
  subscribeTaskSelection?(this: void, listener: () => void): () => void
}

export type ProductDetail = Pick<ProductItem, 'id' | 'tools'>
  & Partial<Omit<ProductItem, 'id' | 'tools' | 'label' | 'description'>>
  & { readonly name: string; readonly summary?: string }

export const METHODS = {
  connectors: 'connectors.list',
  knowledge: 'knowledge.bases.list',
} as const

export const CATEGORY_KEYS: Readonly<Record<string, DeepSeekHarnessProductKey>> = {
  'business-systems': 'categoryBusinessSystems',
  'ecommerce-platforms': 'categoryEcommercePlatforms',
  collaboration: 'categoryCollaboration',
  'data-analysis': 'categoryDataAnalysis',
  'development-operations': 'categoryDevelopmentOperations',
  other: 'categoryOther',
}

export const AUTHORIZATION_TIMEOUT_MS = 60_000

export const AUTHORIZATION_POLL_INTERVAL_MS = 1_000

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('operation cancelled'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new Error('operation cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Validate complete public catalog responses before using resource identities in actions.
 * @param value Untrusted catalog response from the product bridge.
 * @returns Catalog entries with server-issued IDs and validated tools.
 */
export function items(value: unknown): readonly ProductItem[] {
  return ProductCatalogSchema.parse(value)
}

/** Localize an organization knowledge scope; unknown values remain visible for diagnostics.
 * @param value - Server-owned knowledge scope.
 * @param t - Product locale dictionary.
 * @returns Personal, department, or company label.
 */
export function knowledgeScopeLabel(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const keys: Record<string, DeepSeekHarnessProductKey> = { PERSONAL: 'scopePersonal', DEPARTMENT: 'scopeDepartment', COMPANY: 'scopeCompany' }
  const key = keys[value]
  return key === undefined ? value : t(key)
}

/** Translate fixed connector categories, grouping other server labels under Other.
 * @param value Server-owned category identifier.
 * @param t Product locale dictionary.
 * @returns The localized category or Other label.
 */
export function localizedCategory(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const category = value.toLocaleLowerCase()
  const key = Object.hasOwn(CATEGORY_KEYS, category) ? CATEGORY_KEYS[category] : undefined
  return t(key ?? 'categoryOther')
}

export function itemMetadata(item: ProductItem, t: (key: DeepSeekHarnessProductKey) => string): readonly string[] {
  const read = item.tools.filter(tool => tool.access === 'READ').length
  return [t('readCapabilityShort').replace('{count}', String(read)), t('writeCapabilityShort').replace('{count}', String(item.tools.length - read))]
}

export function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

export function normalizedSearch(item: ProductItem): string {
  return [item.label, item.description, item.author, item.category, item.version, item.scope, item.ownerName,
    item.transport, item.authMode, ...item.tools.flatMap(tool => [tool.name, tool.displayName, tool.description])]
    .filter((value): value is string => value !== undefined).join('\n').toLocaleLowerCase()
}

export function localDetail(item: ProductItem): ProductDetail {
  const { label, description, ...metadata } = item
  return { ...metadata, name: label, ...(description === undefined ? {} : { summary: description }) }
}

export function markdownLabels(t: (key: DeepSeekHarnessProductKey) => string) {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: {
      codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'),
    } }, footnotes: t('footnotes'),
  }
}

export function DetailIdentity({ detail: product, icon: Icon, showVisibility = true, t }: {
  readonly detail: ProductDetail
  readonly icon: ComponentType<{ readonly size?: number }>
  readonly showVisibility?: boolean
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <header className={css.detailHeader}>
    <div className={css.detailLead}>
      <div className={css.detailArtwork}><Icon size={28} /></div>
      <div className={css.detailIdentity}>
        <div className={css.detailTitleLine}><h1>{product.name}</h1></div>
        <div className={css.detailMeta}>
          {product.version !== undefined && <span>{t('versionPrefix')}{product.version}</span>}
          {product.category !== undefined && <span>{localizedCategory(product.category, t)}</span>}
        </div>
        <div className={css.detailMeta}>
          {product.author !== undefined && <span>{product.author}</span>}
          {showVisibility && <span>{product.visibility === 'PERSONAL' ? t('personalExtension') : t('sharedExtension')}</span>}
        </div>
      </div>
    </div>
  </header>
}
