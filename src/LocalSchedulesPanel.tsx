import { Bot, Clock3, FolderInput, Info, MoreHorizontal, Play, Plus, RefreshCw, Trash2, X, Zap } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { authorizeLocalDirectory, authorizeLocalFiles } from './harness'
import { attachmentSelectionError } from './attachmentLimits'
import { ScheduleTimeFields } from './ScheduleTimeFields'
import { scheduleLabel } from './scheduleTime'
import { useDialogFocus } from './useDialogFocus'
import { nextLocalRun, type LocalSchedule, type LocalScheduleInput } from './localSchedules'
import type { LocalSchedulesController } from './useLocalSchedules'
import { ScheduleWakeToggle } from './ScheduleWakeToggle'
import { SchedulePopover, ScheduleSelect } from './SchedulePopover'
import { modelDisplayName } from './modelSelection'
import { scheduleRecordGroup, scheduleRunLabels, type RecordGrouping } from './scheduleRecords'
import './scheduleReference.css'

const description = '按计划自动执行任务，也可随时手动触发。在任意对话中描述你想定期做的事，即可快速创建'
const blank = (): LocalScheduleInput => ({ name: '', prompt: '', cronExpression: '0 9 * * *', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, timeZoneMode: 'system', directories: [], attachments: [] })
export function LocalSchedulesPanel({ controller, onOpenTask, onCreateWithXiaoyin, models = [] }: { controller: LocalSchedulesController; onOpenTask: (id: string) => void; onCreateWithXiaoyin?: () => void; models?: string[] }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [draft, setDraft] = useState(blank)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [busy, setBusy] = useState<string[]>([])
  const locks = useRef(new Set<string>())
  const [confirmDelete, setConfirmDelete] = useState<LocalSchedule>()
  const [records, setRecords] = useState(false)
  const [sort, setSort] = useState('created-desc')
  const [grouping, setGrouping] = useState<RecordGrouping>('day')
  const [taskFilter, setTaskFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  useEffect(() => { if (taskFilter && !controller.items.some((item) => item.id === taskFilter)) setTaskFilter('') }, [controller.items, taskFilter])
  const dialog = useRef<HTMLFormElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = '88px'
    element.style.height = `${Math.min(240, Math.max(88, element.scrollHeight))}px`
  }, [open, draft.prompt])
  const deletion = useRef<HTMLDivElement>(null)
  useDialogFocus(dialog, open ? 'local-schedule' : '', () => { if (!saving && !selecting) setOpen(false) })
  useDialogFocus(deletion, confirmDelete?.id ?? '', () => { if (!confirmDelete || !locks.current.has(confirmDelete.id)) setConfirmDelete(undefined) })
  const timeError = useMemo(() => { try { nextLocalRun(draft, new Date()); return '' } catch (reason) { return reason instanceof Error ? reason.message : String(reason) } }, [draft])
  const modelError = draft.model && !models.includes(draft.model) ? '所选模型已不可用，请重新选择。' : ''
  const edit = (item?: LocalSchedule) => { setEditing(item?.id); setDraft(item ? { ...item } : blank()); setError(''); setOpen(true) }
  const operate = async (id: string, action: 'pause' | 'resume' | 'delete' | 'run') => {
    if (locks.current.has(id)) return
    locks.current.add(id); setBusy((items) => [...items, id]); setError('')
    try { await controller.action(id, action); setConfirmDelete(undefined) } catch (reason) { setError(String(reason)) }
    finally { locks.current.delete(id); setBusy((items) => items.filter((item) => item !== id)) }
  }
  const selectContext = async (kind: 'directory' | 'files') => {
    if (selecting || saving) return
    setSelecting(true); setError('')
    try {
      if (kind === 'directory') {
        const directory = await authorizeLocalDirectory()
        if (directory) setDraft((value) => ({ ...value, directories: [directory] }))
      } else {
        const { attachments } = await authorizeLocalFiles()
        const combined = [...draft.attachments ?? [], ...attachments].filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index)
        const message = attachmentSelectionError(combined)
        if (message) throw new Error(message)
        setDraft((value) => ({ ...value, attachments: combined }))
      }
    } catch (reason) { setError(String(reason)) }
    finally { setSelecting(false) }
  }
  const ordered = [...controller.items].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'created-asc' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt))
  const runs = controller.items.flatMap((item) => item.runs.map((run) => ({ item, run })))
    .filter(({ item, run }) => (!taskFilter || item.id === taskFilter) && (!statusFilter || run.status === statusFilter))
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
  const grouped = new Map<string, typeof runs>()
  for (const entry of runs) {
    const key = scheduleRecordGroup(entry.run.startedAt, grouping)
    grouped.set(key, [...grouped.get(key) ?? [], entry])
  }
  return <>
    <header className="schedule-page-heading"><div><h1>定时任务</h1><p>{description}</p></div>
      <div className="schedule-heading-actions">
        <button type="button" className="schedule-refresh" aria-label="刷新定时任务" onClick={() => controller.refresh()}><RefreshCw size={14} /></button>
        {onCreateWithXiaoyin && <button className="schedule-create-with-ai" type="button" onClick={onCreateWithXiaoyin}><Bot size={14} />通过小胤创建</button>}
        <button className="schedule-new-button" onClick={() => edit()} type="button"><Plus size={15} />新建定时任务</button>
      </div>
    </header>
    <div className="schedule-server-note"><span title="需要小胤保持运行；睡眠或关机期间错过的任务不会自动补跑。"><Info size={14} />定时任务仅在电脑保持唤醒时运行</span><ScheduleWakeToggle /></div>
    <div className="schedule-toolbar"><div role="tablist"><button aria-selected={!records} role="tab" className={!records ? 'active' : ''} onClick={() => setRecords(false)} type="button">我的定时任务</button><button aria-selected={records} role="tab" className={records ? 'active' : ''} onClick={() => setRecords(true)} type="button">执行记录</button></div>
      {!records ? <ScheduleSelect label="排序" value={sort} options={[{ value: 'created-desc', label: '按创建时间倒序' }, { value: 'created-asc', label: '按创建时间正序' }, { value: 'name', label: '按名称排序' }]} onChange={setSort} /> :
        <div className="schedule-record-filters"><div className="schedule-record-grouping" role="group" aria-label="记录分组">{([{ value: 'day', label: '按天' }, { value: 'week', label: '按周' }, { value: 'month', label: '按月' }] as const).map((item) => <button type="button" key={item.value} aria-pressed={grouping === item.value} onClick={() => setGrouping(item.value)}>{item.label}</button>)}</div>
          <ScheduleSelect label="按任务筛选" value={taskFilter} options={[{ value: '', label: '全部任务' }, ...controller.items.map((item) => ({ value: item.id, label: item.name }))]} onChange={setTaskFilter} />
          <ScheduleSelect label="按状态筛选" value={statusFilter} options={[{ value: '', label: '全部状态' }, ...Object.entries(scheduleRunLabels).map(([value, label]) => ({ value, label }))]} onChange={setStatusFilter} />
        </div>}
    </div>
    {(!open && error || controller.error) && <p role="alert" className="kit-error">{error || controller.error}</p>}
    {controller.error && <button className="schedule-create-with-ai" type="button" onClick={() => controller.refresh()}><RefreshCw size={14} />重新检查并恢复</button>}
    {!records ? <div className="schedule-list">{ordered.length === 0 && <div className="schedule-empty"><Clock3 size={24} /><strong>暂无定时任务</strong><p>创建一个定时任务，让小胤按计划帮你完成工作</p></div>}
      {ordered.map((item) => {
        const finishedOnce = item.timing?.kind === 'once' && Date.parse(item.nextAt) <= Date.now()
        const hint = item.active ? `下次执行：${new Date(item.nextAt).toLocaleString('zh-CN')}` : finishedOnce ? '已结束；可编辑时间重新安排' : '已暂停'
        return <article className="schedule-card" key={item.id}>
          <div className="schedule-card-top"><button role="switch" aria-checked={item.active} disabled={busy.includes(item.id) || !item.active && finishedOnce} title={hint} aria-label={`${item.active ? '暂停' : '恢复'} ${item.name}`} className={`schedule-toggle ${item.active ? 'active' : ''}`} onClick={() => void operate(item.id, item.active ? 'pause' : 'resume')} type="button"><i /></button>
            <SchedulePopover label={`更多操作 ${item.name}`} className="schedule-card-more" trigger={<MoreHorizontal size={15} />}>{(close) => <div role="menu"><button type="button" role="menuitem" disabled={busy.includes(item.id)} onClick={() => { close(); void operate(item.id, 'run') }}><Play size={13} />立即执行</button><button type="button" role="menuitem" className="danger" onClick={() => { close(); setError(''); setConfirmDelete(item) }}><Trash2 size={13} />删除任务</button></div>}</SchedulePopover>
          </div>
          <button className="schedule-card-edit" type="button" aria-label={`编辑 ${item.name}`} onClick={() => edit(item)}><h3>{item.name}</h3><p>{item.prompt}</p><footer><span title={hint}><Clock3 size={14} />{scheduleLabel(item)}</span></footer></button>
        </article>
      })}
    </div> : <div className="schedule-execution-page">{runs.length === 0 ? <div className="schedule-empty"><Clock3 size={24} /><strong>{taskFilter || statusFilter ? '暂无符合条件的记录' : '暂无执行记录'}</strong><p>{taskFilter || statusFilter ? '试试其他任务或状态' : '当定时任务开始执行后，记录将显示在这里'}</p></div> :
      [...grouped].map(([label, entries]) => <section key={label}><h3>{label}</h3>{entries.map(({ item, run }) => <article key={run.id}><span className={`schedule-run-status ${run.status.toLowerCase()}`}>{scheduleRunLabels[run.status]}</span><div><strong>{item.name}</strong>{run.detail && <small>{run.detail}</small>}</div><time>{new Date(run.startedAt).toLocaleString('zh-CN')}</time>{run.taskId && <button type="button" onClick={() => onOpenTask(run.taskId!)}>查看任务</button>}</article>)}</section>)}
    </div>}
    {open && <div className="schedule-modal-backdrop schedule-reference-backdrop"><form role="dialog" aria-modal="true" aria-label={editing ? '编辑定时任务' : '新建定时任务'} className="schedule-modal schedule-reference-modal" ref={dialog} onSubmit={(event) => {
      event.preventDefault(); if (saving || selecting || !event.currentTarget.checkValidity()) return
      if (timeError || modelError) { setError(timeError || modelError); return }
      setSaving(true); setError('')
      void controller.save(draft, editing).then(() => setOpen(false), (reason) => setError(String(reason))).finally(() => setSaving(false))
    }}>
      <button aria-label="关闭" className="schedule-modal-close" disabled={saving || selecting} onClick={() => setOpen(false)} type="button"><X size={16} /></button>
      <header><h2>{editing ? '编辑定时任务' : '新建定时任务'}</h2><p>{description}</p></header>
      <fieldset className="schedule-form-fields" disabled={saving || selecting}>
        <label>任务名称<input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="描述你的任务" /></label>
        <ScheduleTimeFields value={draft} onChange={setDraft} />
        <div className="schedule-prompt-field"><label htmlFor="schedule-prompt">让小胤帮你做什么...</label>
          <div className="schedule-composer"><textarea ref={textarea} id="schedule-prompt" required maxLength={10000} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="让小胤帮你做什么..." />
            {!!draft.attachments?.length && <div className="schedule-attachments">{draft.attachments.map((file) => <div className="schedule-attachment" key={file.id}><span>{file.name}</span><button type="button" aria-label={`移除附件 ${file.name}`} onClick={() => setDraft({ ...draft, attachments: draft.attachments?.filter((entry) => entry.id !== file.id) })}><X size={12} /></button></div>)}</div>}
            <div className="schedule-composer-toolbar"><div className="schedule-context-actions">
              <SchedulePopover label="工作目录" className="schedule-directory-menu" trigger={<><FolderInput size={15} /><span>{draft.directories.map((entry) => entry.name).join('、') || '选择工作目录'}</span></>}>{(close) => <div role="menu"><button type="button" onClick={() => { close(); void selectContext('directory') }}><FolderInput size={14} />{draft.directories.length ? '更换工作目录' : '选择文件夹'}</button>{!!draft.directories.length && <button type="button" onClick={() => { setDraft({ ...draft, directories: [] }); close() }}><X size={14} />移除工作目录</button>}</div>}</SchedulePopover>
              <button type="button" className="schedule-attach-button" aria-label="添加附件" title="添加附件" onClick={() => void selectContext('files')}><Plus size={16} /></button>
            </div>
              <div className="schedule-model-picker" title="Auto 使用执行时的默认模型"><Zap size={13} /><ScheduleSelect label="任务模型" value={draft.model ?? ''} options={[{ value: '', label: 'Auto' }, ...models.map((model) => ({ value: model, label: modelDisplayName(model) })), ...(draft.model && !models.includes(draft.model) ? [{ value: draft.model, label: `${modelDisplayName(draft.model)}（不可用）` }] : [])]} onChange={(model) => setDraft({ ...draft, model: model || undefined })} /></div>
            </div>
          </div>
        </div>
      </fieldset>
      {(error || timeError || modelError) && <p role="alert" className="kit-error">{error || timeError || modelError}</p>}
      <footer><button className="secondary" type="button" disabled={saving || selecting} onClick={() => setOpen(false)}>取消</button><button type="submit" disabled={saving || selecting}>{saving ? '正在保存…' : '保存'}</button></footer>
    </form></div>}
    {confirmDelete && <div className="schedule-modal-backdrop schedule-reference-backdrop"><div ref={deletion} role="dialog" aria-modal="true" aria-label="删除定时任务" className="schedule-delete-dialog"><h2>删除定时任务？</h2><p>确定删除「{confirmDelete.name}」？计划及执行记录将移除，已有任务对话会保留。</p>{error && <p role="alert">{error}</p>}<footer><button type="button" disabled={busy.includes(confirmDelete.id)} onClick={() => setConfirmDelete(undefined)}>取消</button><button type="button" className="danger" disabled={busy.includes(confirmDelete.id)} onClick={() => void operate(confirmDelete.id, 'delete')}>删除任务</button></footer></div></div>}
  </>
}
