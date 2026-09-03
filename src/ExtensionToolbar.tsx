import { extensionCategories, type ExtensionCategoryFilter } from './extensionCategories'

export type ExtensionFilter = 'market' | 'installed' | 'updates' | 'attention'

export function ExtensionToolbar({ filter, onFilter }: {
  filter: ExtensionFilter
  onFilter: (value: ExtensionFilter) => void
}) {
  const filters: Array<{ id: ExtensionFilter; label: string }> = [
    { id: 'market', label: '企业市场' }, { id: 'installed', label: '已安装' },
    { id: 'updates', label: '可更新' }, { id: 'attention', label: '需要处理' },
  ]
  return <div className="extension-toolbar">
    <div>{filters.map((item) => <button className={filter === item.id ? 'active' : ''} key={item.id} onClick={() => onFilter(item.id)} type="button">{item.label}</button>)}</div>
  </div>
}

export function ExtensionCategoryBar({ value, onChange }: {
  value: ExtensionCategoryFilter
  onChange: (value: ExtensionCategoryFilter) => void
}) {
  return <div aria-label="业务分类" className="extension-category-bar" role="tablist">
    <button aria-selected={value === 'all'} className={value === 'all' ? 'active' : ''} onClick={() => onChange('all')} role="tab" type="button">全部</button>
    {extensionCategories.map((category) => <button aria-selected={value === category.id} className={value === category.id ? 'active' : ''} key={category.id} onClick={() => onChange(category.id)} role="tab" type="button">{category.label}</button>)}
  </div>
}

export function extensionMatches(
  item: { id: string; name: string; summary: string; category?: string; installState: string; readiness: string },
  query: string,
  filter: ExtensionFilter,
  category: ExtensionCategoryFilter = 'all',
): boolean {
  const value = query.trim().toLocaleLowerCase('zh-CN')
  if (value && !`${item.name} ${item.summary} ${item.id}`.toLocaleLowerCase('zh-CN').includes(value)) return false
  if (category !== 'all' && (item.category ?? 'other') !== category) return false
  if (filter === 'installed') return item.installState === 'installed'
  if (filter === 'updates') return item.installState === 'update'
  if (filter === 'attention') return item.installState === 'retired' || item.installState === 'update' || item.readiness === 'partial'
  return item.installState !== 'retired'
}
