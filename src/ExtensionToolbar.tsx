import { extensionCategories, type ExtensionCategoryFilter } from './extensionCategories'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export type ExtensionFilter = 'market' | 'builtin' | 'installed' | 'updates' | 'attention'

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
  const list = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const updateEdges = () => {
    const element = list.current
    if (element) setEdges({ left: element.scrollLeft > 2, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 })
  }
  useEffect(() => {
    updateEdges()
    if (!list.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(list.current)
    return () => observer.disconnect()
  }, [])
  const scroll = (direction: number) => {
    const element = list.current
    element?.scrollBy({ left: direction * element.clientWidth * .7, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  return <div className="category-scroll">
    {edges.left && <button aria-label="向左滚动分类" className="category-arrow left" onClick={() => scroll(-1)} type="button"><ChevronLeft size={15} /></button>}
    <div aria-label="业务分类" className="extension-category-bar" onScroll={updateEdges} ref={list} role="tablist">
    <button aria-selected={value === 'all'} className={value === 'all' ? 'active' : ''} onClick={() => onChange('all')} role="tab" type="button">全部</button>
    {extensionCategories.map((category) => <button aria-selected={value === category.id} className={value === category.id ? 'active' : ''} key={category.id} onClick={() => onChange(category.id)} role="tab" type="button">{category.label}</button>)}
    </div>
    {edges.right && <button aria-label="向右滚动分类" className="category-arrow right" onClick={() => scroll(1)} type="button"><ChevronRight size={15} /></button>}
  </div>
}

export function extensionMatches(
  item: { id: string; name: string; summary: string; category?: string; installState: string; readiness: string; localOnly?: boolean },
  query: string,
  filter: ExtensionFilter,
  category: ExtensionCategoryFilter = 'all',
): boolean {
  const value = query.trim().toLocaleLowerCase('zh-CN')
  if (value && !`${item.name} ${item.summary} ${item.id}`.toLocaleLowerCase('zh-CN').includes(value)) return false
  if (category !== 'all' && (item.category ?? 'other') !== category) return false
  if (filter === 'builtin') return item.localOnly === true && item.installState !== 'retired'
  if (filter === 'installed') return item.installState === 'installed' || item.installState === 'update'
  if (filter === 'updates') return item.installState === 'update'
  if (filter === 'attention') return item.installState === 'retired' || item.installState === 'update' || item.readiness === 'partial'
  return item.installState !== 'retired' && item.localOnly !== true
}
