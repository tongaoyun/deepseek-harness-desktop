import { Cloud, Download, Laptop, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createTaskRunArtifactDownload, loadCloudTaskRuns } from './api'
import type { CloudTaskRun, LocalTaskRun } from './types'

interface Props {
  endpoint: string
  employeeId: string
  accessToken: string
  localTasks: LocalTaskRun[]
  onOpenLocalTask: (task: LocalTaskRun) => void
}

interface TaskCenterItem {
  id: string
  source: 'DESKTOP' | 'SCHEDULE'
  name: string
  status: string
  startedAt: string
  closedAt?: string
  detail: string
  local?: LocalTaskRun
  artifactObjectKey?: string
}

export function TaskCenterPage({ endpoint, employeeId, accessToken,
  localTasks, onOpenLocalTask }: Props) {
  const [cloudTasks, setCloudTasks] = useState<CloudTaskRun[]>([])
  const [scope, setScope] = useState<'all' | 'desktop' | 'cloud'>('all')
  const [loading, setLoading] = useState(true)
  const [refreshToken, setRefreshToken] = useState(0)
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    loadCloudTaskRuns(endpoint, employeeId, accessToken, controller.signal)
      .then(setCloudTasks)
      .catch((reason) => { if (!controller.signal.aborted) setError(message(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [accessToken, employeeId, endpoint, refreshToken])

  const tasks = useMemo<TaskCenterItem[]>(() => [
    ...localTasks.map((task) => ({
      id: task.id, source: task.source, name: task.name, status: task.status,
      startedAt: task.createdAt, closedAt: task.status === 'RUNNING' ? undefined : task.updatedAt,
      detail: task.expertKitId ? `专家套件 · ${task.expertKitId}` : '小胤桌面 Agent', local: task,
    })),
    ...cloudTasks.map((task) => ({
      id: task.id, source: task.source, name: task.name, status: task.status,
      startedAt: task.startedAt, closedAt: task.closedAt,
      detail: `${task.expertKitId} · ${task.workflowId}`, artifactObjectKey: task.artifactObjectKey,
    })),
  ].filter((task) => scope === 'all' || (scope === 'desktop' ? task.source === 'DESKTOP' : task.source === 'SCHEDULE'))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt)), [cloudTasks, localTasks, scope])

  const prepareDownload = async (taskId: string) => {
    setBusyId(taskId)
    setError('')
    try {
      const value = await createTaskRunArtifactDownload(endpoint, employeeId, accessToken, taskId)
      setDownloadUrls((current) => ({ ...current, [taskId]: value.url }))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusyId('')
    }
  }

  return <div className="task-center">
    <div className="task-toolbar">
      <div className="task-filters">
        <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')} type="button">全部</button>
        <button className={scope === 'desktop' ? 'active' : ''} onClick={() => setScope('desktop')} type="button">本机任务</button>
        <button className={scope === 'cloud' ? 'active' : ''} onClick={() => setScope('cloud')} type="button">云端任务</button>
      </div>
      <button className="task-refresh" disabled={loading} onClick={() => setRefreshToken((value) => value + 1)} type="button"><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button>
    </div>
    {loading && tasks.length === 0 && <div className="kit-empty">正在汇总任务记录…</div>}
    {!loading && tasks.length === 0 && <div className="kit-empty">当前还没有任务记录</div>}
    <div className="task-run-list">{tasks.map((task) => <article key={`${task.source}:${task.id}`}>
      <span className={`task-source ${task.source.toLowerCase()}`}>{task.source === 'DESKTOP' ? <Laptop size={14} /> : <Cloud size={14} />}{task.source === 'DESKTOP' ? '本机' : '云端'}</span>
      <div className="task-run-main"><h3>{task.name}</h3><p>{task.detail}</p><time>{new Date(task.startedAt).toLocaleString()}</time></div>
      <span className={`execution-status ${task.status.toLowerCase()}`}>{statusLabel(task.status)}</span>
      <div className="task-run-actions">
        {task.local && <button onClick={() => onOpenLocalTask(task.local!)} type="button">打开对话</button>}
        {task.artifactObjectKey && !downloadUrls[task.id] && <button disabled={busyId === task.id} onClick={() => void prepareDownload(task.id)} type="button"><Download size={13} />获取产物</button>}
        {downloadUrls[task.id] && <a href={downloadUrls[task.id]} rel="noreferrer" target="_blank"><Download size={13} />下载产物</a>}
      </div>
    </article>)}</div>
    {error && <div className="kit-error">{error}</div>}
  </div>
}

function statusLabel(status: string): string {
  return ({ RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELED: '已取消',
    TERMINATED: '已终止', UNKNOWN: '未知' } as Record<string, string>)[status] ?? status
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
