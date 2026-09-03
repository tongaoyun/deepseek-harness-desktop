import { BookOpenCheck, Boxes, CalendarClock, MessageSquare, PanelLeftClose, PanelLeftOpen, PlugZap, Plus, Search, WandSparkles, X } from 'lucide-react'
import { type RefObject, useState } from 'react'
import { AccountMenu } from './AccountMenu'
import type { LocalTaskRun } from './types'

const extensions = [
  { id: 'experts', label: '专家套件', icon: Boxes },
  { id: 'skills', label: '技能', icon: WandSparkles },
  { id: 'connectors', label: '连接器', icon: PlugZap },
  { id: 'knowledge', label: '知识库', icon: BookOpenCheck },
]

interface Props {
  collapsed: boolean
  page: string
  taskSearchOpen: boolean
  taskQuery: string
  taskSearchInputRef: RefObject<HTMLInputElement | null>
  tasks: LocalTaskRun[]
  visibleTasks: LocalTaskRun[]
  user?: { companyName?: string; department?: string; displayName?: string }
  onNewTask: () => void
  onToggleCollapsed: () => void
  onToggleSearch: () => void
  onTaskQuery: (value: string) => void
  onCloseSearch: () => void
  onPage: (page: string) => void
  onOpenTask: (task: LocalTaskRun) => void
  onFeedback: (message: string) => Promise<void>
  onLogout: () => Promise<void>
}

export function DesktopSidebar(props: Props) {
  const [historyView, setHistoryView] = useState<'tasks' | 'channels'>('tasks')
  const navItem = (id: string, label: string, Icon: typeof Boxes) => <button aria-current={props.page === id ? 'page' : undefined} className={props.page === id ? 'nav-item active' : 'nav-item'} onClick={() => props.onPage(id)} title={props.collapsed ? label : undefined} type="button"><Icon size={17} /><span>{label}</span></button>
  return <aside className="sidebar">
    <div className="sidebar-brand">
      <div className="sidebar-toolbar">
        <button aria-expanded={props.taskSearchOpen} aria-label="搜索任务" onClick={props.onToggleSearch} title="搜索任务（Ctrl/⌘ K）" type="button"><Search size={15} /></button>
        <button aria-label={props.collapsed ? '展开侧栏' : '收起侧栏'} onClick={props.onToggleCollapsed} type="button">{props.collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
      </div>
    </div>
    {props.taskSearchOpen && <label className="task-search"><Search size={14} /><input aria-label="搜索最近任务" onChange={(event) => props.onTaskQuery(event.target.value)} placeholder="搜索最近任务" ref={props.taskSearchInputRef} value={props.taskQuery} /><button aria-label="关闭搜索" onClick={props.onCloseSearch} type="button"><X size={13} /></button></label>}
    <button className="new-task" onClick={props.onNewTask} title={props.collapsed ? '新任务' : undefined} type="button"><Plus size={18} /><span>新任务</span></button>
    <p className="nav-label extension-label"><Boxes size={13} />扩展</p>
    <nav className="extension-nav">{extensions.map(({ id, label, icon }) => <span key={id}>{navItem(id, label, icon)}</span>)}</nav>
    <nav className="office-nav">
      {navItem('schedules', '定时任务', CalendarClock)}
      {navItem('im', 'IM 频道', MessageSquare)}
    </nav>
    <div className="sidebar-segments"><button className={historyView === 'tasks' ? 'active' : ''} onClick={() => setHistoryView('tasks')} type="button">任务</button><button className={historyView === 'channels' ? 'active' : ''} onClick={() => setHistoryView('channels')} type="button">频道</button></div>
    {historyView === 'tasks'
      ? <div className="recent-tasks">
        <p className="nav-label">最近</p>
        {props.visibleTasks.slice(0, 8).map((task) => <button className="recent-task" key={task.id} onClick={() => props.onOpenTask(task)} type="button"><span>{task.name}</span><small>{task.status === 'RUNNING' ? '运行中' : task.status === 'COMPLETED' ? '已完成' : task.status === 'CANCELED' ? '已取消' : '执行失败'}</small></button>)}
        {props.tasks.length === 0 && <small className="recent-empty">暂无任务</small>}
        {props.tasks.length > 0 && props.visibleTasks.length === 0 && <small className="recent-empty">没有匹配的任务</small>}
      </div>
      : <div className="recent-tasks channel-history"><p className="nav-label">最近</p><button className="recent-task" onClick={() => props.onPage('im')} type="button"><span>IM 频道</span><small>查看最近会话</small></button></div>}
    <div className="sidebar-spacer" />
    <AccountMenu companyName={props.user?.companyName} department={props.user?.department} displayName={props.user?.displayName} onFeedback={props.onFeedback} onLogout={props.onLogout} onSettings={() => props.onPage('settings')} />
  </aside>
}
