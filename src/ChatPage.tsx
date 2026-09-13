import { ArrowDown, ChevronRight, CircleStop, FileImage, FileText, Keyboard, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject, type UIEvent } from 'react'
import type { AuthorizedLocalDirectory } from './harness'
import { FileChangesCard } from './FileChangesCard'
import { InlineTaskActivity } from './InlineTaskActivity'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import type { LocalArtifactTarget } from './localArtifactPreview'
import { TaskArtifacts } from './TaskArtifacts'
import { TaskOutcomeDetails } from './TaskOutcomeDetails'
import { TaskRecoveryNotice } from './TaskRecoveryNotice'
import { TaskOperationReview } from './TaskOperationReview'
import { TaskVisuals } from './TaskVisuals'
import type { CapabilitySnapshot, KnowledgeBaseEntry, LocalTaskAttachment, RuntimeStatus, TaskMessage, XiaoyinTaskProjection } from './types'
import { XiaoyinMascot } from './XiaoyinMascot'
import type { ExtensionInvocation } from './extensionInvocations'
import { TaskComposer } from './TaskComposer'
import { splitComposerPrompt } from './composerInput'
import { TaskQueuePanel } from './TaskQueuePanel'
import type { TaskQueue } from './useTaskQueue'

import { RichMessage } from './RichMessage'
import { KnowledgeSources } from './KnowledgeSources'
import type { KnowledgeSourceContext } from './api'
export interface ChatPageProps {
  employeeId?: string
  onResumeInterrupted?: () => void
  knowledgeContext?: KnowledgeSourceContext
  taskId?: string
  fileChangesBusy?: boolean
  onChangesUndone?: (messageIndex: number, results: import('./localArtifactPreview').UndoFileResult[]) => void
  messages: TaskMessage[]
  prompt: string
  taskProjection: XiaoyinTaskProjection
  taskContextRestoring?: boolean
  capabilitySnapshot?: CapabilitySnapshot
  harnessHealth: 'checking' | 'ready' | 'degraded'
  harnessHealthDetail: string
  harnessRunning: boolean
  runtimeStatus: RuntimeStatus
  activeModel: string
  models: string[]
  executionMode?: 'agent' | 'plan'
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
  onPrepareRetry: () => void
  onReconnect: () => void
  onRecoverHarness: () => void
  onAddLocalDirectory: () => void
  onAddLocalFiles: () => void
  onToggleModelMenu: () => void
  onSelectModel: (model: string) => void
  onExecutionModeChange?: (mode: 'agent' | 'plan') => void
  onCancel: () => void
  onApprovalDecision?: import('./ExecutionTimeline').ApprovalDecisionHandler
  onQuestionAnswer?: import('./ExecutionTimeline').QuestionAnswerHandler
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
  const initialStart = Math.max(0, props.messages.length - 60)
  const historyStart = historyWindow.taskId === props.taskId ? Math.min(historyWindow.start ?? initialStart, initialStart) : initialStart
  if (historyWindow.taskId !== props.taskId || (historyWindow.start === undefined && props.messages.length > 0)) setHistoryWindow({ taskId: props.taskId, start: initialStart })
  const historyAnchor = useRef<{ height: number; top: number } | undefined>(undefined)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const shortcutButton = useRef<HTMLButtonElement>(null)
  const closeShortcuts = () => { setShortcutsOpen(false); shortcutButton.current?.focus() }
  const [previewTargets, setPreviewTargets] = useState<LocalArtifactTarget[]>([])
  const [previewKey, setPreviewKey] = useState('')
  const pinnedToBottom = useRef(true)
  const previousMessageCount = useRef(props.messages.length)
  const lastMessage = props.messages.at(-1)
  const previewTarget = previewTargets.find((target) => artifactKey(target) === previewKey) ?? previewTargets.at(-1)
  const openPreview = useCallback((target: LocalArtifactTarget) => {
    const key = artifactKey(target)
    setPreviewTargets((current) => current.some((item) => artifactKey(item) === key) ? current.map((item) => artifactKey(item) === key ? target : item) : [...current, target].slice(-8))
    setPreviewKey(key)
  }, [])
  const reviewFiles = useCallback((targets: LocalArtifactTarget[]) => {
    if (!targets.length) return
    setPreviewTargets(targets)
    setPreviewKey(artifactKey(targets[0]))
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
    previousMessageCount.current = props.messages.length
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
    const addedMessage = props.messages.length > previousMessageCount.current
    previousMessageCount.current = props.messages.length
    // Incoming output must not pull the reader away from earlier messages.
    if (!pinnedToBottom.current && !(addedMessage && lastMessage?.role === 'user')) return
    // Align the viewport before paint, not one animation frame after content reflows.
    scrollToBottom('auto')
  }, [props.messages.length, lastMessage?.pending, lastMessage?.text, props.taskProjection.updatedAt])

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
  }, [props.messageListRef, props.messages.length, props.taskId, historyStart])

  useEffect(() => {
    const closeMenus = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setShortcutsOpen(false)
    }
    document.addEventListener('keydown', closeMenus)
    return () => document.removeEventListener('keydown', closeMenus)
  }, [])

  useEffect(() => {
    if (props.messages.length === 0) {
      setPreviewTargets([])
      setPreviewKey('')
    }
  }, [props.messages.length])

  return <div className={`chat-workspace${props.messages.length > 0 ? ' has-conversation' : ''}${previewTarget ? ' preview-open' : ''}`}><section className={props.messages.length > 0 ? 'chat-page conversation' : 'chat-page'}>
    <div className="chat-topbar"><button aria-expanded={shortcutsOpen} aria-label="快捷键指引" onClick={() => setShortcutsOpen((value) => !value)} ref={shortcutButton} title="快捷键指引" type="button"><Keyboard size={16} /></button></div>
    {shortcutsOpen && <div className="shortcuts-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeShortcuts() }} role="presentation"><section aria-label="快捷键指引" aria-modal="true" className="shortcuts-dialog" role="dialog" onKeyDown={(event) => { if (event.key === 'Tab') { event.preventDefault(); event.currentTarget.querySelector('button')?.focus() } if (event.key === 'Escape') { event.stopPropagation(); closeShortcuts() } }}><header><h2>快捷键指引</h2><button aria-label="关闭快捷键指引" autoFocus onClick={closeShortcuts} type="button"><X size={16} /></button></header><dl><div><dt>新任务</dt><dd><kbd>⌘ / Ctrl</kbd> <kbd>N</kbd></dd></div><div><dt>搜索任务</dt><dd><kbd>⌘ / Ctrl</kbd> <kbd>K</kbd></dd></div><div><dt>发送消息</dt><dd><kbd>Enter</kbd></dd></div><div><dt>换行</dt><dd><kbd>Shift</kbd> <kbd>Enter</kbd></dd></div><div><dt>调用技能或套件</dt><dd><kbd>/</kbd></dd></div><div><dt>关闭菜单或详情</dt><dd><kbd>Esc</kbd></dd></div></dl></section></div>}
    {props.messages.length === 0 && <div className="hero-copy">
      <XiaoyinMascot size={48} variant="hero" />
      <h1>不止聊天，搞定一切</h1>
      <p>本地运行、自主规划、安全可控的 AI 工作搭子</p>
    </div>}
    <span aria-live="polite" className="sr-only">{props.taskProjection.activity}</span>
    {props.messages.length > 0 && <div aria-label="任务对话" className="message-list" onScroll={trackScroll} ref={props.messageListRef} role="log">{historyStart > 0 && <button className="conversation-load-earlier" type="button" onClick={() => {
      const list = props.messageListRef.current
      if (list) historyAnchor.current = { height: list.scrollHeight, top: list.scrollTop }
      pinnedToBottom.current = false
      setHistoryWindow({ taskId: props.taskId, start: Math.max(0, historyStart - 60) })
    }}>加载更早的消息（还有 {historyStart} 条）</button>}{props.messages.slice(historyStart).map((message, offset) => {
      const index = historyStart + offset
      const projection = message.projection ?? (message.role === 'assistant' && index === props.messages.length - 1 ? props.taskProjection : undefined)
      const messageInput = splitComposerPrompt(message.text)
      if (message.role === 'user') return <article className="conversation-turn user-turn" key={`${message.role}-${index}`}>
        <div className="user-prompt">
          {messageInput.tokens.map((token) => <span key={token} className="message-capability"><Sparkles size={12} />{props.invocations?.find((item) => item.token === token)?.name ?? token.replace(/^\/(?:kit|skill):/u, '')}</span>)}
          {message.attachments && message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
          <RichMessage assistant={false} text={messageInput.text || (messageInput.tokens.length ? '使用所选能力开始任务' : message.text)} />
        </div>
      </article>
      const timelineOwnsStreamingText = message.pending && (projection?.timeline?.some((entry) => entry.kind === 'assistant') ?? false)
      const reviewChanges = projection?.changes ?? []
      const fileChanges = !message.pending && reviewChanges.length > 0 && <FileChangesCard changes={reviewChanges} busy={props.fileChangesBusy ?? props.harnessRunning} onOpen={openPreview} onReview={reviewFiles} onUndone={(results) => {
        setPreviewTargets([])
        setPreviewKey('')
        props.onChangesUndone?.(index, results)
      }} />
      return <article aria-busy={message.pending} className={`conversation-turn assistant-turn${message.pending ? ' pending' : ''}`} key={`${message.role}-${index}`}>
        {projection && <InlineTaskActivity finalResponse={message.pending ? '' : message.text} projection={projection} onApprovalDecision={props.onApprovalDecision} onQuestionAnswer={props.onQuestionAnswer} />}
        {(!timelineOwnsStreamingText && Boolean(message.text.trim())) && <div className={message.pending ? 'streaming-response' : undefined}><RichMessage assistant={!message.pending} onRegenerate={!message.pending && index === props.messages.length - 1 ? props.onPrepareRetry : undefined} text={message.text} /></div>}
        {projection && projection.artifacts.length > 0 && <TaskArtifacts artifacts={projection.artifacts} conversation onOpen={openPreview} />}
        {fileChanges && (projection?.artifacts.length ? <details className="task-file-review"><summary><ChevronRight size={14} />文件变更 <small>{reviewChanges.length}</small></summary>{fileChanges}</details> : fileChanges)}
        {!message.pending && projection?.status === 'completed' && projection.outcome && <TaskOutcomeDetails outcome={projection.outcome} />}
        {!message.pending && projection?.interruption && <TaskRecoveryNotice projection={projection} disabled={props.harnessRunning || Boolean(props.taskContextRestoring) || Boolean(props.prompt.trim()) || props.pendingAttachments.length > 0} onResume={index === props.messages.length - 1 ? props.onResumeInterrupted : undefined} />}
        {!message.pending && index === props.messages.length - 1 && props.employeeId && props.taskId && <TaskOperationReview key={`${props.employeeId}:${props.taskId}`} employeeId={props.employeeId} taskId={props.taskId} revision={props.taskProjection.updatedAt} disabled={props.harnessRunning} />}
        {!message.pending && projection?.knowledgeSources && <KnowledgeSources sources={projection.knowledgeSources} context={props.knowledgeContext} />}
        {!message.pending && props.employeeId && projection && (projection.visuals?.length ?? 0) > 0 && <TaskVisuals employeeId={props.employeeId} key={props.taskId} visuals={projection.visuals ?? []} />}
        {!message.pending && projection?.status === 'completed' && index === props.messages.length - 1 && props.creationKind && props.onContinueCreation && <div className="creation-handoff">
          <span><Sparkles size={16} /><span><strong>继续完成创建</strong><small>把当前方案带入创作表单，确认后保存到本机。</small></span></span>
          <button onClick={() => props.onContinueCreation?.(message.text)} type="button">{props.creationKind === 'expert-kit' ? '保存为专家套件' : '保存为技能'}</button>
        </div>}
      </article>
    })}</div>}
    {showScrollDown && <button aria-label="滚动到最新消息" className="scroll-to-latest" onClick={() => scrollToBottom()} title="滚动到最新消息" type="button"><ArrowDown size={18} /></button>}
    {props.runtimeStatus === 'offline'
      ? <div className="runtime-recovery"><CircleStop size={17} /><span><strong>企业服务暂不可用</strong><small>请检查内网连接后重试</small></span><button onClick={props.onReconnect} type="button">重新连接</button></div>
      : props.harnessHealth === 'degraded' && <div className="runtime-recovery"><CircleStop size={17} /><span><strong>本地 Agent 暂不可用</strong><small>{props.harnessHealthDetail}</small></span><button onClick={props.onRecoverHarness} type="button">重新检测</button></div>}
    <TaskQueuePanel queue={props.queue} onRemove={props.onRemoveQueued} onEdit={props.onEditQueued} onResume={props.onResumeQueue} onPause={props.onPauseQueue} />
    {props.queueError && <p className="local-file-error" role="alert">{props.queueError}</p>}
    <TaskComposer {...props} onPreview={openPreview} onSubmit={(event) => {
      // Explicit sends return to the live turn. Background queue messages do not.
      if (!props.harnessRunning) pinnedToBottom.current = true
      props.onSubmit(event)
    }} />
  </section>{previewTarget && <LocalFilePreviewPanel onClose={closePreview} onOpenSelected={openPreview} onSelect={(target) => setPreviewKey(artifactKey(target))} tabs={previewTargets} target={previewTarget} />}</div>
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
