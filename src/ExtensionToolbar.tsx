import { Search, X } from 'lucide-react'

export type ExtensionFilter = 'market' | 'installed' | 'updates' | 'attention'

export function ExtensionToolbar({ filter, query, onFilter, onQuery }: {
  filter: ExtensionFilter
  query: string
  onFilter: (value: ExtensionFilter) => void
  onQuery: (value: string) => void
}) {
  const filters: Array<{ id: ExtensionFilter; label: string }> = [
    { id: 'market', label: '企业市场' }, { id: 'installed', label: '已安装' },
    { id: 'updates', label: '可更新' }, { id: 'attention', label: '需要处理' },
  ]
  return <div className="extension-toolbar">
    <label><Search size={14} /><input aria-label="搜索扩展" onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称、说明或 ID" value={query} />{query && <button aria-label="清空搜索" onClick={() => onQuery('')} type="button"><X size={12} /></button>}</label>
    <div>{filters.map((item) => <button className={filter === item.id ? 'active' : ''} key={item.id} onClick={() => onFilter(item.id)} type="button">{item.label}</button>)}</div>
  </div>
}

export function extensionMatches(
  item: { id: string; name: string; summary: string; installState: string; readiness: string },
  query: string,
  filter: ExtensionFilter,
): boolean {
  const value = query.trim().toLocaleLowerCase('zh-CN')
  if (value && !`${item.name} ${item.summary} ${item.id}`.toLocaleLowerCase('zh-CN').includes(value)) return false
  if (filter === 'installed') return item.installState === 'installed'
  if (filter === 'updates') return item.installState === 'update'
  if (filter === 'attention') return item.installState === 'retired' || item.installState === 'update' || item.readiness === 'partial'
  return item.installState !== 'retired'
}
