import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconSearchOutlineRegular, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import type { ConnectorTool } from './catalog-shared.tsx'
import css from '../DeepSeekHarnessProduct.module.css'

const PAGE_SIZE = 20

/** Browse large MCP catalogs without expanding every model-facing instruction.
 * @param props - Declared tools and localized labels; browsing never invokes a tool.
 * @returns Searchable capability rows with individually expandable descriptions.
 */
export function ConnectorTools({ tools, t }: {
  readonly tools: readonly ConnectorTool[]
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [query, setQuery] = useState('')
  const [access, setAccess] = useState('all')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const revealFocus = useRef<number>()
  const needle = query.trim().toLocaleLowerCase()
  const filtered = tools.filter(tool => (access === 'all' || tool.access === access)
    && [tool.displayName, tool.name, tool.description].some(value => value?.toLocaleLowerCase().includes(needle)))
  useLayoutEffect(() => {
    const index = revealFocus.current
    revealFocus.current = undefined
    if (index === undefined || filtered.length > visibleCount) return
    const target = list.current?.children[index]?.querySelector<HTMLElement>('summary')
    if (target) focusWithoutRing(target)
  }, [visibleCount, filtered.length])
  const clear = () => {
    setQuery(''); setAccess('all'); setVisibleCount(PAGE_SIZE)
    if (search.current) focusWithoutRing(search.current)
  }
  return <details className={css.detailDisclosure}>
    <summary><span>{t('viewConnectorTools').replace('{count}', String(tools.length))}</span>
      <IconChevronRightOutlineRegular size={14} /></summary>
    <div className={css.disclosureBody}>
      <div className={css.connectorToolFilters}>
        <label className={css.searchField}><IconSearchOutlineRegular size={16} />
          <input ref={search} type="search" aria-label={t('searchConnectorTools')} placeholder={t('connectorToolSearchPlaceholder')} value={query}
            onChange={(event) => { setQuery(event.currentTarget.value); setVisibleCount(PAGE_SIZE) }} /></label>
        <select aria-label={t('connectorToolAccess')} value={access}
          onChange={(event) => { setAccess(event.currentTarget.value); setVisibleCount(PAGE_SIZE) }}>
          <option value="all">{t('connectorAllTools')}</option>
          <option value="READ">{t('readOnlyLabel')}</option><option value="WRITE">{t('writeLabel')}</option>
        </select>
      </div>
      {filtered.length === 0 ? <div className={css.catalogStatus}><p>{t('noSearchResults')}</p>
        <Button variant="ghost" size="sm" onClick={clear}>{t('clearConnectorFilters')}</Button></div>
        : <>
          <ul ref={list} className={css.detailToolList}>{filtered.slice(0, visibleCount).map(tool => <li key={tool.name}>
            <details className={css.connectorToolDetail}>
              <summary className={css.toolRow}><strong>{tool.displayName}</strong>
                <span className={css.connectorToolEnd}><span className={css.toolPermission} data-access={tool.access}>
                  {tool.access === 'READ' ? t('readOnlyLabel') : t('writeLabel')}</span><IconChevronRightOutlineRegular size={14} /></span>
              </summary>
              <div className={css.connectorToolDescription}><code>{tool.name}</code>
                {tool.description && <p>{tool.description}</p>}</div>
            </details>
          </li>)}</ul>
          {filtered.length > visibleCount && <Button variant="ghost" size="sm"
            onClick={(event) => {
              revealFocus.current = document.activeElement === event.currentTarget ? visibleCount : undefined
              setVisibleCount(value => value + PAGE_SIZE)
            }}>{t('showMoreConnectorTools')
              .replace('{shown}', String(Math.min(visibleCount, filtered.length))).replace('{total}', String(filtered.length))}</Button>}
        </>}
    </div>
  </details>
}
