import { FileText, Play, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  applyHarnessNotification,
  cancelHarness,
  createTaskMonitor,
  listenHarnessNotifications,
  runHarness,
} from './harness'
import type { ConnectorRuntimeDefinition, TaskMonitorState } from './types'
import type { ExtensionValidationReport } from './extensionSubmissions'
import { parseTaskOutcome, taskOutcomeLabel, unverifiedTaskOutcome } from './taskOutcome'
import { TaskOutcomeDetails } from './TaskOutcomeDetails'

export interface ExtensionPreviewConfig {
  employeeId: string
  teamId: string
  litellmBaseUrl: string
  knowledgeEndpoint: string
  scheduleEndpoint: string
  connectors: ConnectorRuntimeDefinition[]
  model: string
  modelApiKey: string
  accessToken: string
  localFileRootIds: string[]
}

interface PreviewTarget {
  kind: 'expert-kit' | 'skill'
  id: string
  version: string
  sha256: string
  knowledgeBaseRefs: string[]
  allowLocalFiles: boolean
}

interface Props {
  target?: PreviewTarget
  config?: ExtensionPreviewConfig
  unavailableReason?: string
  onRunningChange: (running: boolean) => void
  onReport?: (report: ExtensionValidationReport) => void
}

export function ExtensionPreviewPanel({ target, config, unavailableReason, onRunningChange, onReport }: Props) {
  const [prompt, setPrompt] = useState('请执行一次最小范围的能力验证，并说明使用了哪些步骤和工具。')
  const [running, setRunning] = useState(false)
  const [monitor, setMonitor] = useState<TaskMonitorState>(createTaskMonitor)
  const [response, setResponse] = useState('')
  const [error, setError] = useState('')
  const monitorRef = useRef(monitor)
  const runningRef = useRef(false)
  const previewTaskIdRef = useRef(`extension-preview-${crypto.randomUUID()}`)
  const onRunningChangeRef = useRef(onRunningChange)
  onRunningChangeRef.current = onRunningChange

  useEffect(() => {
    let disposed = false
    let unlisten: () => void = () => undefined
    void listenHarnessNotifications((notification) => {
      if (disposed || !runningRef.current || notification.taskId !== previewTaskIdRef.current) return
      const next = applyHarnessNotification(monitorRef.current, notification)
      monitorRef.current = next
      setMonitor(next)
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    return () => {
      disposed = true
      unlisten()
      if (runningRef.current) void cancelHarness(previewTaskIdRef.current)
      runningRef.current = false
      previewTaskIdRef.current = ''
      onRunningChangeRef.current(false)
    }
  }, [])

  useEffect(() => {
    if (runningRef.current) {
      runningRef.current = false
      void cancelHarness(previewTaskIdRef.current)
      setRunning(false)
      onRunningChangeRef.current(false)
    }
    previewTaskIdRef.current = ''
    setResponse('')
    setError('')
    const idle = createTaskMonitor()
    monitorRef.current = idle
    setMonitor(idle)
  }, [target?.id, target?.kind])

  if (!target) return null

  const run = async () => {
    if (!config || running || !prompt.trim()) return
    const startedAt = new Date().toISOString()
    const startedAtMs = Date.now()
    const runId = `extension-preview-${crypto.randomUUID()}`
    previewTaskIdRef.current = runId
    const started: TaskMonitorState = {
      ...createTaskMonitor(startedAt),
      status: 'running',
      activity: '正在启动发布前试运行',
    }
    setRunning(true)
    runningRef.current = true
    onRunningChangeRef.current(true)
    monitorRef.current = started
    setMonitor(started)
    setResponse('')
    setError('')
    try {
      const result = await runHarness({
        operationScope: crypto.randomUUID(),
        taskId: runId,
        prompt: prompt.trim(),
        executionMode: 'agent',
        employeeId: config.employeeId,
        teamId: config.teamId,
        capabilitySnapshot: {
          schemaVersion: 1,
          createdAt: startedAt,
          selections: [{
            mode: 'explicit', kind: target.kind, extensionId: target.id, extensionVersion: target.version,
            ...(target.kind === 'skill' ? { skillId: target.id } : {}),
          }],
          artifacts: [{ kind: target.kind, id: target.id, version: target.version, sha256: target.sha256 }],
          implicitArtifacts: [],
          requestedConnectorIds: config.connectors.map((connector) => connector.id),
          knowledgeBaseRefs: target.knowledgeBaseRefs,
          requestedKnowledgeBaseRefs: target.knowledgeBaseRefs,
          connectors: config.connectors,
        },
        litellmBaseUrl: config.litellmBaseUrl,
        knowledgeEndpoint: config.knowledgeEndpoint,
        scheduleEndpoint: config.scheduleEndpoint,
        model: config.model,
        modelApiKey: config.modelApiKey,
        accessToken: config.accessToken,
        localFileRootIds: target.allowLocalFiles ? config.localFileRootIds : [],
        attachments: [],
      })
      if (previewTaskIdRef.current !== runId || !runningRef.current) return
      if (!result.finalResponse.trim()) throw new Error('试运行未返回可显示文本，请重试')
      const outcome = parseTaskOutcome(result.outcome) ?? unverifiedTaskOutcome()
      const completed: TaskMonitorState = {
        ...monitorRef.current,
        status: 'completed',
        outcome,
        activity: taskOutcomeLabel(outcome),
        updatedAt: new Date().toISOString(),
      }
      monitorRef.current = completed
      setMonitor(completed)
      const finalResponse = result.finalResponse
      setResponse(finalResponse)
      const discoveredTools = [...new Set(completed.steps.flatMap((step) => step.toolName ? [step.toolName] : []))]
      onReport?.({
        type: 'HARNESS', status: outcome.status === 'completed' ? 'PASSED' : 'FAILED', prompt: prompt.trim(), model: config.model,
        latencyMs: Math.max(0, Date.now() - startedAtMs), discoveredTools,
        steps: completed.steps.map((step) => ({ kind: step.kind, label: step.label, status: step.status, toolName: step.toolName ?? '' })),
        artifacts: completed.artifacts.map((artifact) => ({ name: artifact.name, kind: artifact.kind, sourceTool: artifact.sourceTool })),
        finalResponse, completedAt: completed.updatedAt,
      })
    } catch (reason) {
      if (previewTaskIdRef.current !== runId || !runningRef.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      const failed: TaskMonitorState = {
        ...monitorRef.current,
        status: runningRef.current ? 'failed' : 'canceled',
        activity: runningRef.current ? '试运行失败' : '试运行已取消',
        updatedAt: new Date().toISOString(),
      }
      monitorRef.current = failed
      setMonitor(failed)
      if (runningRef.current) setError(message)
    } finally {
      if (previewTaskIdRef.current === runId) {
        runningRef.current = false
        setRunning(false)
        onRunningChangeRef.current(false)
      }
    }
  }

  const cancel = async () => {
    if (!runningRef.current) return
    const runId = previewTaskIdRef.current
    runningRef.current = false
    await cancelHarness(runId).catch(() => false)
    if (previewTaskIdRef.current !== runId) return
    const canceled: TaskMonitorState = {
      ...monitorRef.current,
      status: 'canceled',
      activity: '试运行已取消',
      updatedAt: new Date().toISOString(),
    }
    monitorRef.current = canceled
    setMonitor(canceled)
    setRunning(false)
    onRunningChangeRef.current(false)
  }

  return <section className="extension-preview">
    <header><span><strong>发布前试运行</strong><small>只在本机执行当前草稿，不提交审核、不写入正式任务记录。</small></span><em className={monitor.status}>{monitor.status === 'completed' ? taskOutcomeLabel(monitor.outcome) : previewStatusLabel(monitor.status)}</em></header>
    <div className="extension-preview-input">
      <textarea disabled={running} onChange={(event) => setPrompt(event.target.value)} value={prompt} />
      {running
        ? <button className="cancel" onClick={() => void cancel()} type="button"><Square size={12} />停止</button>
        : <button disabled={!config || !prompt.trim()} onClick={() => void run()} type="button"><Play size={12} />开始试运行</button>}
    </div>
    {unavailableReason && <div className="extension-preview-warning">{unavailableReason}</div>}
    {monitor.steps.length > 0 && <div className="extension-preview-steps">{monitor.steps.map((step) => <article key={step.id}><i className={step.status} /><span><strong>{step.label}</strong><small>{step.toolName ?? step.kind}</small></span><em>{stepStatusLabel(step.status)}</em></article>)}</div>}
    {monitor.artifacts.length > 0 && <div className="extension-preview-artifacts"><strong>产物</strong>{monitor.artifacts.map((artifact) => <span key={artifact.id}><FileText size={12} />{artifact.name}<small>{artifact.sourceTool}</small></span>)}</div>}
    {response && <div className="extension-preview-response"><strong>最终回复</strong><p>{response}</p></div>}
    {monitor.status === 'completed' && <TaskOutcomeDetails outcome={monitor.outcome} />}
    {error && <div className="authoring-error">{error}</div>}
  </section>
}

export function previewStatusLabel(status: TaskMonitorState['status']) {
  return {
    idle: '等待测试',
    running: '运行中',
    completed: '本轮已结束',
    failed: '失败',
    canceled: '已取消',
  }[status]
}

function stepStatusLabel(status: TaskMonitorState['steps'][number]['status']) {
  return status === 'running' ? '执行中' : status === 'completed' ? '完成' : '失败'
}
