import { Archive, BookOpenCheck, Boxes, CalendarClock, ChevronDown, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, PlugZap, Plus, RotateCcw, Search, SquareCheck, Trash2, WandSparkles, X } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useEffect, useState } from 'react'
import { AccountMenu } from './AccountMenu'
import { ChannelHistory } from './ChannelHistory'
import type { LocalTaskRun } from './types'

const extensions = [
  { id: 'packs', label: '专家套件', icon: Boxes },
  { id: 'skills', label: '技能', icon: WandSparkles },
  { id: 'connectors', label: '连接器', icon: PlugZap },
  { id: 'knowledge', label: '知识库', icon: BookOpenCheck },
]

interface Props {
  collapsed: boolean
  channelOwner?: string
  onOpenChannel?: (key: string) => void
  activeTaskId?: string
  page: string
  taskSearchOpen: boolean
  taskQuery: string
  taskSearchInputRef: RefObject<HTMLInputElement | null>
  tasks: LocalTaskRun[]
  visibleTasks: LocalTaskRun[]
  historyMore?: boolean
  historyBusy?: boolean
  historyError?: string
  onLoadHistory?: () => void
  user?: { companyName?: string; department?: string; displayName?: string }
  onNewTask: () => void
  onToggleCollapsed: () => void
  onToggleSearch: () => void
  onTaskQuery: (value: string) => void
  onCloseSearch: () => void
  onPage: (page: string) => void
  onOpenTask: (task: LocalTaskRun) => void
  onRenameTask: (task: LocalTaskRun, name: string) => void
  onArchiveTask: (task: LocalTaskRun, archived: boolean) => void
  onDeleteTask: (task: LocalTaskRun) => void
  onFeedback: (message: string, category: 'BUG' | 'SUGGESTION' | 'QUESTION' | 'OTHER', images?: File[]) => Promise<void>
  onLogout: () => Promise<void>
}

export function DesktopSidebar(props: Props) {
  const [extensionsOpen, setExtensionsOpen] = useState(true)
  const [historyView, setHistoryView] = useState<'tasks' | 'channels'>('tasks')
  const [menuTaskId, setMenuTaskId] = useState('')
  const [editingTaskId, setEditingTaskId] = useState('')
  const [editingName, setEditingName] = useState('')
  useEffect(() => {
    if (!menuTaskId) return
    const dismiss = (event: PointerEvent) => {
      const owner = (event.target as Element | null)?.closest('[data-task-menu]')
      if (owner?.getAttribute('data-task-menu') !== menuTaskId) setMenuTaskId('')
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuTaskId('') }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuTaskId])
  const listedTasks = props.visibleTasks.filter((task) => props.taskQuery.trim() || !task.archivedAt)
  const taskUnread = (task: LocalTaskRun) => task.status !== 'RUNNING'
    && !(props.page === 'chat' && props.activeTaskId === task.id)
    && (!task.lastOpenedAt || task.updatedAt > task.lastOpenedAt)
  const navItem = (id: string, label: string, Icon: typeof Boxes) => <button aria-current={props.page === id ? 'page' : undefined} className={props.page === id ? 'nav-item active' : 'nav-item'} onClick={() => props.onPage(id)} title={props.collapsed ? label : undefined} type="button"><Icon size={17} /><span>{label}</span></button>
  return <aside className="sidebar">
    <div className="sidebar-brand">
      <div className="sidebar-toolbar">
        <button aria-expanded={props.taskSearchOpen} aria-label="搜索任务" onClick={props.onToggleSearch} title="搜索任务（Ctrl/⌘ K）" type="button"><Search size={15} /></button>
        <button aria-label={props.collapsed ? '展开侧栏' : '收起侧栏'} onClick={props.onToggleCollapsed} type="button">{props.collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
      </div>
    </div>
    {props.taskSearchOpen && <label className="task-search"><Search size={14} /><input aria-label="搜索任务" onChange={(event) => props.onTaskQuery(event.target.value)} placeholder="搜索任务、会话或技能" ref={props.taskSearchInputRef} value={props.taskQuery} /><button aria-label="关闭搜索" onClick={props.onCloseSearch} type="button"><X size={13} /></button></label>}
    <button className="new-task" onClick={props.onNewTask} title={props.collapsed ? '新任务' : undefined} type="button"><Plus size={18} /><span>新任务</span></button>
    <p className="sidebar-section-label">工作区</p>
    <button aria-expanded={extensionsOpen} className="nav-label extension-label extension-group-toggle" onClick={() => setExtensionsOpen((value) => !value)} type="button"><Boxes size={13} /><span>扩展</span><ChevronDown className={extensionsOpen ? '' : 'closed'} size={12} /></button>
    {(extensionsOpen || props.collapsed) && <nav aria-label="扩展" className="extension-nav">{extensions.map(({ id, label, icon }) => <span key={id}>{navItem(id, label, icon)}</span>)}</nav>}
    <p className="sidebar-section-label sidebar-section-label-office">自动化</p>
    <nav className="office-nav">
      {navItem('schedules', '定时任务', CalendarClock)}
      {navItem('im', 'IM 频道', MessageSquare)}
    </nav>
    <div className="sidebar-segments"><button className={historyView === 'tasks' ? 'active' : ''} onClick={() => setHistoryView('tasks')} type="button"><SquareCheck size={15} />任务</button><button className={historyView === 'channels' ? 'active' : ''} onClick={() => setHistoryView('channels')} type="button"><MessageSquare size={15} />频道</button></div>
    {historyView !== 'channels'
      ? <div className="recent-tasks">
        <div className="recent-heading"><p className="nav-label">最近任务</p></div>
        {listedTasks.map((task) => <div className="recent-task-wrap" data-task-menu={task.id} key={task.id}>
          {editingTaskId === task.id
            ? <form onSubmit={(event) => { event.preventDefault(); props.onRenameTask(task, editingName); setEditingTaskId('') }}><input autoFocus aria-label="任务名称" maxLength={120} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditingTaskId('') }} value={editingName} /></form>
            : <button aria-current={props.page === 'chat' && props.activeTaskId === task.id ? 'true' : undefined} aria-label={task.status === 'RUNNING' ? `${task.name}，运行中` : taskUnread(task) ? `${task.name}，有新结果` : task.name} className={`recent-task${props.page === 'chat' && props.activeTaskId === task.id ? ' active' : ''}`} onClick={() => props.onOpenTask(task)} type="button"><span>{task.name}</span>{task.status === 'RUNNING' ? <span aria-label="运行中" className="recent-task-state" title="运行中"><LoaderCircle className="recent-task-spinner" size={14} /></span> : taskUnread(task) ? <span aria-label="有新结果" className="recent-task-state recent-task-unread-dot" title="有新结果" /> : null}</button>}
          <button aria-expanded={menuTaskId === task.id} aria-label={`管理 ${task.name}`} className="recent-task-more" onClick={() => setMenuTaskId((current) => current === task.id ? '' : current)} type="button"><MoreHorizontal size={14} /></button>
          {menuTaskId === task.id && <div className="recent-task-menu" onKeyDown={navigateMenu} role="menu">
            {!task.archivedAt && <button disabled={task.status === 'RUNNING'} onClick={() => { setEditingName(task.name); setEditingTaskId(task.id); setMenuTaskId('') }} role="menuitem" type="button"><Pencil size={13} />重命名</button>}
            <button disabled={task.status === 'RUNNING'} onClick={() => { props.onArchiveTask(task, !task.archivedAt); setMenuTaskId('') }} role="menuitem" type="button">{task.archivedAt ? <RotateCcw size={13} /> : <Archive size={13} />}{task.archivedAt ? '移出归档' : '归档'}</button>
            <button className="danger" disabled={task.status === 'RUNNING'} onClick={() => { props.onDeleteTask(task); setMenuTaskId('') }} role="menuitem" type="button"><Trash2 size={13} />删除</button>
          </div>}
        </div>)}
        {props.tasks.length === 0 && <small className="recent-empty">暂无任务</small>}
        {props.tasks.length > 0 && listedTasks.length === 0 && <small className="recent-empty">{props.taskQuery ? '没有匹配的任务' : '暂无任务'}</small>}
        {props.historyError && <small role="alert" className="recent-empty">{props.historyError}</small>}
        {(props.historyMore || props.historyError) && <button className="recent-task" disabled={props.historyBusy} onClick={props.onLoadHistory} type="button">{props.historyBusy ? '正在加载…' : props.historyError ? '重试加载' : '加载更早任务'}</button>}
      </div>
      : <ChannelHistory key={props.channelOwner} onConfigure={() => props.onPage('im')} onOpen={(key) => props.onOpenChannel ? props.onOpenChannel(key) : props.onPage('im')} />}
    <div className="sidebar-spacer" />
    <AccountMenu companyName={props.user?.companyName} department={props.user?.department} displayName={props.user?.displayName} onFeedback={props.onFeedback} onLogout={props.onLogout} onSettings={() => props.onPage('settings')} />
  </aside>
}

function navigateMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  if (items.length === 0) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length : current) - 1
  items[index]?.focus()
}
