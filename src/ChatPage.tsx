import { ArrowDown, BookOpen, FileImage, FileText, Plug, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject, type UIEvent } from 'react'
import type { AuthorizedLocalDirectory } from './harness'
import { AssistantTurnView } from './chat/AssistantTurnView'
import { activeRunStartedAt } from './chat/turnElapsed'
import type { ApprovalDecisionHandler } from './chat/ApprovalCard'
import type { QuestionAnswerHandler } from './chat/QuestionCard'
import { TurnFooter } from './chat/TurnFooter'
import { FileChangesCard } from './FileChangesCard'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import type { LocalArtifactTarget } from './localArtifactPreview'
import { TaskArtifacts } from './TaskArtifacts'
import { TaskRecoveryNotice } from './TaskRecoveryNotice'
import { isUnverifiedTaskOutcome } from './taskOutcome'
import { TaskOutcomeDetails } from './TaskOutcomeDetails'
import { TaskOperationReview } from './TaskOperationReview'
import { TaskVisuals } from './TaskVisuals'
import type { AssistantTurn, ConversationEntry } from './conversation/types'
import type { CapabilitySnapshot, KnowledgeBaseEntry, LocalTaskAttachment, RuntimeStatus, XiaoyinTaskProjection } from './types'
import { XiaoyinMascot } from './XiaoyinMascot'
import type { ExtensionInvocation } from './extensionInvocations'
import { TaskComposer } from './TaskComposer'
import { splitComposerPrompt } from './composerInput'
import { TaskQueuePanel } from './TaskQueuePanel'
import type { TaskQueue } from './useTaskQueue'
import type { HarnessHealth } from './useHarnessHealth'
import { connectorDisplayName } from './connectors'

import { RichMessage } from './RichMessage'
import { KnowledgeSources } from './KnowledgeSources'
import type { KnowledgeSourceContext } from './api'

export interface ChatPageProps {
  employeeId?: string
  onResumeInterrupted?: () => void
  knowledgeContext?: KnowledgeSourceContext
  taskId?: string
  fileChangesBusy?: boolean
  onChangesUndone?: (results: import('./localArtifactPreview').UndoFileResult[]) => void
  entries: ConversationEntry[]
  prompt: string
  taskProjection: XiaoyinTaskProjection
  taskContextRestoring?: boolean
  capabilitySnapshot?: CapabilitySnapshot
  harnessHealth: HarnessHealth
  harnessHealthDetail: string
  harnessRunning: boolean
  runtimeStatus: RuntimeStatus
  activeModel: string
  executionMode?: 'agent' | 'plan'
  onExecutionModeChange?: (mode: 'agent' | 'plan') => void
  reasoningEffort?: import('./modelReasoning').ReasoningEffort
  onReasoningEffortChange?: (value: import('./modelReasoning').ReasoningEffort) => void
  models: string[]
  modelMenuOpen: boolean
  currentTaskRunning?: boolean
  queue?: TaskQueue
  queueError?: string
  onRemoveQueued?: (id: string) => void
  onEditQueued?: (id: string, text: string) => void
  onResumeQueue?: () => void
  onPauseQueue?: () => void
  knowledgeBases: KnowledgeBaseEntry[]
  selectedKnowledgeBaseRefs: string[]
  localDirectories: AuthorizedLocalDirectory[]
  pendingAttachments: LocalTaskAttachment[]
  localFileError: string
  messageListRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<HTMLTextAreaElement | null>
  modelPickerRef: RefObject<HTMLDivElement | null>
  onPrompt: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onEditTurn: () => void
  onRegenerateTurn?: () => void
  onReconnect: () => void
  onRecoverHarness: () => void
  onAddLocalDirectory: () => void
  onAddLocalFiles: () => void
  onToggleModelMenu: () => void
  onSelectModel: (model: string) => void
  onCancel: () => void
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
  onAddKnowledge: (reference: string) => void
  onRemoveKnowledge: (reference: string) => void
  onRemoveLocalDirectory: (id: string) => void
  onRemoveAttachment: (id: string) => void
  creationKind?: 'skill' | 'expert-kit'
  invocations?: ExtensionInvocation[]
  composerConnectors?: import('./types').ConnectorRuntimeDefinition[]
  selectedConnectorIds?: string[]
  onToggleTaskConnector?: (id: string) => void
  onBrowseCapability?: (kind: 'expert-kit' | 'skill' | 'connector' | 'knowledge') => void
  recentDirectories?: AuthorizedLocalDirectory[]
  sessionReferences?: Array<{ sessionId: string; label: string; updatedAt: string }>
  onSelectRecentDirectory?: (path: string) => void
  onPasteFiles?: (files: File[]) => Promise<boolean>
  pastingAttachments?: boolean
  onContinueCreation?: (instructions: string) => void
}

export function ChatPage(props: ChatPageProps) {
  const [historyWindow, setHistoryWindow] = useState<{ taskId?: string; start?: number }>({ taskId: props.taskId })
  const initialStart = Math.max(0, props.entries.length - 60)
  const historyStart = historyWindow.taskId === props.taskId ? Math.min(historyWindow.start ?? initialStart, initialStart) : initialStart
  if (historyWindow.taskId !== props.taskId || (historyWindow.start === undefined && props.entries.length > 0)) setHistoryWindow({ taskId: props.taskId, start: initialStart })
  const historyAnchor = useRef<{ height: number; top: number } | undefined>(undefined)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [previewTargets, setPreviewTargets] = useState<LocalArtifactTarget[]>([])
  const [previewKey, setPreviewKey] = useState('')
  const pinnedToBottom = useRef(true)
  const previousEntryCount = useRef(props.entries.length)
  const lastEntry = props.entries.at(-1)
  const previewTarget = previewTargets.find((target) => artifactKey(target) === previewKey) ?? previewTargets.at(-1)
  const openPreview = useCallback((target: LocalArtifactTarget) => {
    const key = artifactKey(target)
    setPreviewTargets((current) => current.some((item) => artifactKey(item) === key) ? current.map((item) => artifactKey(item) === key ? target : item) : [...current, target].slice(-8))
    setPreviewKey(key)
  }, [])
  const reviewFiles = useCallback((targets: LocalArtifactTarget[]) => {
    if (!targets.length) return
    setPreviewTargets(targets)
    setPreviewKey(artifactKey(targets[0]!))
  }, [])
  const closePreview = useCallback(() => {
    setPreviewTargets([])
    setPreviewKey('')
  }, [])

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const list = props.messageListRef.current
    if (!list) return
    pinnedToBottom.current = true
    setShowScrollDown(false)
    const effectiveBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior
    list.scrollTo({ top: list.scrollHeight, behavior: effectiveBehavior })
  }

  const trackScroll = (event: UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 96
    pinnedToBottom.current = atBottom
    setShowScrollDown(!atBottom)
  }

  useLayoutEffect(() => {
    historyAnchor.current = undefined
    pinnedToBottom.current = true
    previousEntryCount.current = props.entries.length
    scrollToBottom('auto')
  }, [props.taskId])

  useLayoutEffect(() => {
    const list = props.messageListRef.current
    if (list && historyAnchor.current) {
      list.scrollTop = historyAnchor.current.top + list.scrollHeight - historyAnchor.current.height
      historyAnchor.current = undefined
    }
  }, [historyStart])

  useLayoutEffect(() => {
    const addedEntry = props.entries.length > previousEntryCount.current
    previousEntryCount.current = props.entries.length
    // Incoming output must not pull the reader away from earlier messages.
    if (!pinnedToBottom.current && !(addedEntry && lastEntry?.role === 'user')) return
    // Align the viewport before paint, not one animation frame after content reflows.
    scrollToBottom('auto')
  }, [props.entries.length, lastEntry?.role, props.taskProjection.updatedAt])

  useEffect(() => {
    setPreviewTargets([])
    setPreviewKey('')
  }, [props.taskId])

  useEffect(() => {
    const list = props.messageListRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current) list.scrollTo({ top: list.scrollHeight, behavior: 'auto' })
    })
    observer.observe(list)
    for (const child of list.children) observer.observe(child)
    return () => observer.disconnect()
  }, [props.messageListRef, props.entries.length, props.taskId, historyStart])

  useEffect(() => {
    if (props.entries.length === 0) {
      setPreviewTargets([])
      setPreviewKey('')
    }
  }, [props.entries.length])

  const reviewChanges = props.taskProjection.changes ?? []
  const changedFiles = new Set(reviewChanges.map((change) => `${change.rootId}:${change.path}`))
  const standaloneArtifacts = props.taskProjection.artifacts.filter((artifact) => !changedFiles.has(`${artifact.rootId}:${artifact.path}`))
  const fileChanges = reviewChanges.length > 0 && <FileChangesCard changes={reviewChanges} busy={props.fileChangesBusy ?? props.harnessRunning} onOpen={openPreview} onReview={reviewFiles} onUndone={(results) => {
    setPreviewTargets([])
    setPreviewKey('')
    props.onChangesUndone?.(results)
  }} />
  const lastIndex = props.entries.length - 1

  return <div className={`chat-workspace${props.entries.length > 0 ? ' has-conversation' : ''}${previewTarget ? ' preview-open' : ''}`}><section className={props.entries.length > 0 ? 'chat-page conversation' : 'chat-page'}>
    {props.entries.length === 0 && <div className="hero-copy">
      <XiaoyinMascot size={48} variant="hero" />
      <h1>不止聊天，搞定一切</h1>
      <p>本地运行、自主规划、安全可控的 AI 工作搭子</p>
    </div>}
    <span aria-live="polite" className="sr-only">{props.taskProjection.activity}</span>
    {props.entries.length > 0 && <div aria-label="任务对话" className="message-list" onScroll={trackScroll} ref={props.messageListRef} role="log">{historyStart > 0 && <button className="conversation-load-earlier" type="button" onClick={() => {
      const list = props.messageListRef.current
      if (list) historyAnchor.current = { height: list.scrollHeight, top: list.scrollTop }
      pinnedToBottom.current = false
      setHistoryWindow({ taskId: props.taskId, start: Math.max(0, historyStart - 60) })
    }}>加载更早的消息（还有 {historyStart} 条）</button>}{props.entries.slice(historyStart).map((entry, offset) => {
      const index = historyStart + offset
      const isLast = index === lastIndex
      if (entry.role === 'user') return <UserTurnView entry={entry} invocations={props.invocations} knowledgeBases={props.knowledgeBases} key={`user-${entry.id}-${index}`} />
      return <article className={`conversation-turn assistant-turn${entry.status === 'streaming' ? ' pending' : ''}`} aria-busy={entry.status === 'streaming'} key={`assistant-${entry.id}-${index}`}>
        <AssistantTurnView
          turn={entry}
          runState={isLast ? props.taskProjection : undefined}
          elapsedStartedAt={isLast ? activeRunStartedAt(props.entries, index) : undefined}
          onApprovalDecision={props.onApprovalDecision}
          onQuestionAnswer={props.onQuestionAnswer}
        />
        {isLast && standaloneArtifacts.length > 0 && <TaskArtifacts artifacts={standaloneArtifacts} conversation onOpen={openPreview} />}
        {isLast && fileChanges}
        {isLast && entry.status !== 'streaming' && props.taskProjection.status === 'completed' && props.taskProjection.outcome
          && !isUnverifiedTaskOutcome(props.taskProjection.outcome) && <TaskOutcomeDetails outcome={props.taskProjection.outcome} />}
        {isLast && entry.status !== 'streaming' && props.taskProjection.interruption && <TaskRecoveryNotice projection={props.taskProjection} disabled={props.harnessRunning || Boolean(props.taskContextRestoring) || Boolean(props.prompt.trim()) || props.pendingAttachments.length > 0} onResume={props.onResumeInterrupted} />}
        {isLast && entry.status !== 'streaming' && props.employeeId && props.taskId && <TaskOperationReview key={`${props.employeeId}:${props.taskId}`} employeeId={props.employeeId} taskId={props.taskId} revision={props.taskProjection.updatedAt} disabled={props.harnessRunning} />}
        {isLast && entry.status !== 'streaming' && props.taskProjection.knowledgeSources && <KnowledgeSources sources={props.taskProjection.knowledgeSources} context={props.knowledgeContext} />}
        {isLast && entry.status !== 'streaming' && props.employeeId && (props.taskProjection.visuals?.length ?? 0) > 0 && <TaskVisuals employeeId={props.employeeId} key={props.taskId} visuals={props.taskProjection.visuals ?? []} />}
        {isLast && entry.status !== 'streaming' && props.taskProjection.status === 'completed' && props.creationKind && props.onContinueCreation && <div className="creation-handoff">
          <span><Sparkles size={16} /><span><strong>继续完成创建</strong><small>把当前方案带入创作表单，确认后保存到本机。</small></span></span>
          <button onClick={() => props.onContinueCreation?.(turnTextOf(entry))} type="button">{props.creationKind === 'expert-kit' ? '保存为专家套件' : '保存为技能'}</button>
        </div>}
        <TurnFooter turn={entry} actions={isLast ? { completedAt: props.taskProjection.completedAt, latest: true, onRegenerate: props.onRegenerateTurn, onEdit: props.onEditTurn } : undefined} />
      </article>
    })}</div>}
    {showScrollDown && <button aria-label="滚动到最新消息" className="scroll-to-latest" onClick={() => scrollToBottom()} title="滚动到最新消息" type="button"><ArrowDown size={18} /></button>}
    {props.runtimeStatus === 'offline'
      ? <div className="runtime-recovery"><span><strong>企业服务暂不可用</strong><small>请检查内网连接后重试</small></span><button onClick={props.onReconnect} type="button">重新连接</button></div>
      : props.harnessHealth === 'degraded' && <div className="runtime-recovery"><span><strong>本地 Agent 暂不可用</strong><small>{props.harnessHealthDetail}</small></span><button onClick={props.onRecoverHarness} type="button">重新检测</button></div>}
    <TaskQueuePanel queue={props.queue} onRemove={props.onRemoveQueued} onEdit={props.onEditQueued} onResume={props.onResumeQueue} onPause={props.onPauseQueue} />
    {props.queueError && <p className="local-file-error" role="alert">{props.queueError}</p>}
    <TaskComposer {...props} onPreview={openPreview} onSubmit={(event) => {
      // Explicit sends return to the live turn. Background queue messages do not.
      if (!props.harnessRunning) pinnedToBottom.current = true
      props.onSubmit(event)
    }} />
  </section>{previewTarget && <LocalFilePreviewPanel onClose={closePreview} onOpenSelected={openPreview} onSelect={(target) => setPreviewKey(artifactKey(target))} tabs={previewTargets} target={previewTarget} />}</div>
}

function UserTurnView({ entry, invocations, knowledgeBases }: { entry: Extract<ConversationEntry, { role: 'user' }>; invocations?: ExtensionInvocation[]; knowledgeBases: KnowledgeBaseEntry[] }) {
  const messageInput = splitComposerPrompt(entry.text)
  return <article className="conversation-turn user-turn">
    <div className="user-prompt">
      {entry.source === 'steer' && <span className="steer-badge"><Sparkles size={12} />已插入当前任务</span>}
      {messageInput.tokens.map((token) => <span key={token} className="message-capability"><Sparkles size={12} />{invocations?.find((item) => item.token === token)?.name ?? token.replace(/^\/(?:kit|skill):/u, '')}</span>)}
      {entry.context?.knowledgeRefs?.map((reference) => <span className="message-capability context-ref" key={reference} title={`知识库 ${reference}`}><BookOpen size={12} />{knowledgeBases.find((item) => item.reference === reference)?.name ?? reference}</span>)}
      {entry.context?.connectors?.map((connector) => {
        const label = connectorDisplayName(connector)
        return label ? <span className="message-capability context-ref" key={connector.id} title="已选择连接器"><Plug size={12} />{label}</span> : null
      })}
      {entry.attachments && entry.attachments.length > 0 && <AttachmentList attachments={entry.attachments} />}
      <RichMessage text={messageInput.text || (messageInput.tokens.length ? '使用所选能力开始任务' : entry.text)} />
    </div>
  </article>
}

function turnTextOf(entry: AssistantTurn): string {
  return entry.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('\n\n')
}

function artifactKey(target: LocalArtifactTarget): string { return `${target.rootId}:${target.path}` }

function AttachmentList({ attachments, onRemove }: { attachments: LocalTaskAttachment[]; onRemove?: (id: string) => void }) {
  return <div className={`message-attachments${onRemove ? ' removable' : ''}`}>
    {attachments.map((attachment) => <span className="attachment-chip" key={attachment.id} title={`${attachment.rootName}/${attachment.path}`}>
      {attachment.kind === 'image' ? <FileImage size={14} /> : <FileText size={14} />}
      <span><strong>{attachment.name}</strong><small>{attachment.rootName}</small></span>
      {onRemove && <button aria-label={`移除 ${attachment.name}`} type="button" onClick={() => onRemove(attachment.id)}><X size={11} /></button>}
    </span>)}
  </div>
}
