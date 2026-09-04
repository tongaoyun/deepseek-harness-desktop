import { ArrowDown, BookOpen, Bot, Check, ChevronDown, CirclePlus, CircleStop, FileImage, FilePlus2, FileText, FolderOpen, Send, Sparkles, SquareCheckBig, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type RefObject, type UIEvent } from 'react'
import type { AuthorizedLocalDirectory } from './harness'
import { FileChangesCard } from './FileChangesCard'
import { InlineTaskActivity } from './InlineTaskActivity'
import { modelDisplayName } from './modelSelection'
import { TaskArtifacts } from './TaskArtifacts'
import type { CapabilitySnapshot, KnowledgeBaseEntry, LocalTaskAttachment, RuntimeStatus, TaskMessage, TaskMonitorState } from './types'
import { XiaoyinMascot } from './XiaoyinMascot'

const RichMessage = lazy(() => import('./RichMessage').then((module) => ({ default: module.RichMessage })))
interface Props {
  messages: TaskMessage[]
  prompt: string
  taskMonitor: TaskMonitorState
  taskContextRestoring?: boolean
  capabilitySnapshot?: CapabilitySnapshot
  harnessHealth: 'checking' | 'ready' | 'degraded'
  harnessHealthDetail: string
  harnessRunning: boolean
  runtimeStatus: RuntimeStatus
  selectedCapabilityName: string
  selectedCapabilityId: string
  capabilityOptions: Array<{ id: string; name: string; summary: string }>
  activeModel: string
  models: string[]
  modelMenuOpen: boolean
  currentTaskRunning?: boolean
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
  onSelectCapability: (id: string) => void
  onToggleModelMenu: () => void
  onSelectModel: (model: string) => void
  onCancel: () => void
  onAddKnowledge: (reference: string) => void
  onRemoveKnowledge: (reference: string) => void
  onRemoveLocalDirectory: (id: string) => void
  onRemoveAttachment: (id: string) => void
  creationKind?: 'expert-kit' | 'skill'
  onContinueCreation?: (instructions: string) => void
}

export function ChatPage(props: Props) {
  const [showScrollDown, setShowScrollDown] = useState(false)
  const currentTaskRunning = props.currentTaskRunning ?? props.harnessRunning
  const [capabilityMenuOpen, setCapabilityMenuOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const pinnedToBottom = useRef(true)
  const previousMessageCount = useRef(props.messages.length)
  const capabilityPickerRef = useRef<HTMLDivElement>(null)
  const contextPickerRef = useRef<HTMLDivElement>(null)
  const lastMessage = props.messages.at(-1)

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

  useEffect(() => {
    const addedMessage = props.messages.length > previousMessageCount.current
    previousMessageCount.current = props.messages.length
    if (!addedMessage && !pinnedToBottom.current) return
    const frame = window.requestAnimationFrame(() => scrollToBottom(addedMessage ? 'smooth' : 'auto'))
    return () => window.cancelAnimationFrame(frame)
  }, [props.messages.length, lastMessage?.pending, lastMessage?.text, props.taskMonitor.updatedAt])

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!capabilityPickerRef.current?.contains(event.target as Node)) setCapabilityMenuOpen(false)
      if (!contextPickerRef.current?.contains(event.target as Node)) setContextMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])

  return <section className={props.messages.length > 0 ? 'chat-page conversation' : 'chat-page'}>
    {props.messages.length === 0 && <div className="hero-copy">
      <XiaoyinMascot size={62} variant="hero" />
      <h1>不止聊天，搞定一切</h1>
      <p>本地运行、自主规划、安全可控的 AI 工作搭子</p>
    </div>}
    {props.messages.length > 0 && <div aria-live="polite" className="message-list" onScroll={trackScroll} ref={props.messageListRef}>{props.messages.map((message, index) => {
      const monitor = message.monitor ?? (message.role === 'assistant' && index === props.messages.length - 1 ? props.taskMonitor : undefined)
      if (message.role === 'user') return <article className="conversation-turn user-turn" key={`${message.role}-${index}`}>
        <div className="user-prompt">
          {message.attachments && message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
          <Suspense fallback={<p>{message.text}</p>}><RichMessage assistant={false} text={message.text} /></Suspense>
        </div>
      </article>
      const timelineOwnsStreamingText = message.pending && (monitor?.timeline?.some((entry) => entry.kind === 'assistant') ?? false)
      return <article aria-busy={message.pending} className={`conversation-turn assistant-turn${message.pending ? ' pending' : ''}`} key={`${message.role}-${index}`}>
        {monitor && <InlineTaskActivity finalResponse={message.text} monitor={monitor} />}
        {(!timelineOwnsStreamingText && (!message.pending || message.text)) && <div className={message.pending ? 'streaming-response' : undefined}><Suspense fallback={<p>{message.text}</p>}><RichMessage assistant={!message.pending} onRegenerate={!message.pending && index === props.messages.length - 1 ? props.onPrepareRetry : undefined} text={message.text} /></Suspense></div>}
        {!message.pending && monitor && (monitor.changes?.length ?? 0) > 0 && <FileChangesCard changes={monitor.changes ?? []} />}
        {!message.pending && monitor && monitor.artifacts.length > 0 && <TaskArtifacts artifacts={monitor.artifacts} conversation />}
        {!message.pending && monitor?.status === 'completed' && index === props.messages.length - 1 && props.creationKind && props.onContinueCreation && <div className="creation-handoff">
          <span><Sparkles size={16} /><span><strong>继续完成创建</strong><small>把当前方案带入创作表单，确认后保存到本机。</small></span></span>
          <button onClick={() => props.onContinueCreation?.(message.text)} type="button">保存为{props.creationKind === 'expert-kit' ? '专家套件' : '技能'}</button>
        </div>}
      </article>
    })}</div>}
    {showScrollDown && <button aria-label="滚动到最新消息" className="scroll-to-latest" onClick={() => scrollToBottom()} title="滚动到最新消息" type="button"><ArrowDown size={18} /></button>}
    {props.runtimeStatus === 'offline'
      ? <div className="runtime-recovery"><CircleStop size={17} /><span><strong>企业服务暂不可用</strong><small>请检查内网连接后重试</small></span><button onClick={props.onReconnect} type="button">重新连接</button></div>
      : props.harnessHealth === 'degraded' && <div className="runtime-recovery"><CircleStop size={17} /><span><strong>本地 Agent 暂不可用</strong><small>{props.harnessHealthDetail}</small></span><button onClick={props.onRecoverHarness} type="button">重新检测</button></div>}
    <form className="composer" onSubmit={props.onSubmit}>
      <textarea aria-label="给小胤发送消息" onChange={(event) => props.onPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="描述你想完成的任务" ref={props.composerRef} value={props.prompt} />
      <div className="composer-actions">
        <div className="context-picker" ref={contextPickerRef}>
          <button aria-expanded={contextMenuOpen} aria-label="添加上下文" className="workspace-button context-add-button" disabled={props.harnessRunning} onClick={() => { setContextMenuOpen((value) => !value); setCapabilityMenuOpen(false) }} title="添加文件、文件夹或知识库" type="button"><CirclePlus size={19} /></button>
          {contextMenuOpen && <div className="composer-popover context-menu">
            <small>添加上下文</small>
            <button onClick={() => { setContextMenuOpen(false); props.onAddLocalFiles() }} type="button"><FilePlus2 size={16} /><span><strong>文件</strong><small>添加图片、文档或其他任务资料</small></span></button>
            <button onClick={() => { setContextMenuOpen(false); props.onAddLocalDirectory() }} type="button"><FolderOpen size={16} /><span><strong>文件夹</strong><small>允许小胤在该目录中读取和修改文件</small></span></button>
            {props.knowledgeBases.filter((item) => !props.selectedKnowledgeBaseRefs.includes(item.reference)).length > 0 && <>
              <small>知识库</small>
              {props.knowledgeBases.filter((item) => !props.selectedKnowledgeBaseRefs.includes(item.reference)).slice(0, 6).map((item) => <button key={item.reference} onClick={() => { props.onAddKnowledge(item.reference); setContextMenuOpen(false) }} type="button"><BookOpen size={16} /><span><strong>{item.name}</strong><small>{item.description || knowledgeScopeLabel(item.scope)}</small></span></button>)}
            </>}
          </div>}
        </div>
        {(props.capabilityOptions.length > 0 || props.selectedCapabilityId) && <div className="capability-picker" ref={capabilityPickerRef}>
          <button aria-expanded={capabilityMenuOpen} className={`mode-button${props.selectedCapabilityId ? ' selected' : ''}`} disabled={currentTaskRunning} onClick={() => { setCapabilityMenuOpen((value) => !value); setContextMenuOpen(false) }} title="按需使用专家套件" type="button"><Sparkles size={14} /> {props.selectedCapabilityName} <ChevronDown size={13} /></button>
          {capabilityMenuOpen && <div className="composer-popover capability-menu">
            <small>专家套件（可选）</small>
            <button className={!props.selectedCapabilityId ? 'active' : ''} onClick={() => { props.onSelectCapability(''); setCapabilityMenuOpen(false) }} type="button"><Sparkles size={16} /><span><strong>不使用专家套件</strong><small>小胤仍会按任务自动调用技能、工具和连接器</small></span>{!props.selectedCapabilityId && <Check size={15} />}</button>
            {props.capabilityOptions.map((option) => <button className={props.selectedCapabilityId === option.id ? 'active' : ''} key={option.id} onClick={() => { props.onSelectCapability(option.id); setCapabilityMenuOpen(false) }} type="button"><Sparkles size={16} /><span><strong>{option.name}</strong><small>{option.summary}</small></span>{props.selectedCapabilityId === option.id && <Check size={15} />}</button>)}
          </div>}
        </div>}
        <div className="model-picker" ref={props.modelPickerRef}>
          <button aria-expanded={props.modelMenuOpen} className="model-label" disabled={currentTaskRunning} onClick={props.onToggleModelMenu} type="button"><Bot size={14} /> {modelDisplayName(props.activeModel)} <ChevronDown size={13} /></button>
          {props.modelMenuOpen && <div className="model-menu"><small>公司可用模型</small>{(props.models.length ? props.models : [props.activeModel]).map((model) => <button className={model === props.activeModel ? 'active' : ''} key={model} onClick={() => props.onSelectModel(model)} title={model} type="button"><span><strong>{modelDisplayName(model)}</strong></span>{model === props.activeModel && <SquareCheckBig size={14} />}</button>)}</div>}
        </div>
        {currentTaskRunning
          ? <button aria-label="取消当前任务" className="cancel-button" onClick={props.onCancel} title="取消当前任务" type="button"><CircleStop size={17} /></button>
          : <button aria-label="发送" className="send-button" disabled={(!props.prompt.trim() && props.pendingAttachments.length === 0) || props.runtimeStatus !== 'ready' || props.harnessHealth === 'degraded' || props.taskContextRestoring} title={props.runtimeStatus !== 'ready' ? '企业服务未连接' : props.harnessHealth === 'degraded' ? '请先恢复本地 Agent' : props.taskContextRestoring ? '正在恢复任务目录' : '发送'} type="submit"><Send size={17} /></button>}
      </div>
    </form>
    {props.localFileError && <div className="local-file-error">{props.localFileError}</div>}
    <div className="context-bar">
      <div className="local-contexts">
        {props.selectedKnowledgeBaseRefs.map((reference) => <span className="local-context" key={reference}><BookOpen size={12} />{props.knowledgeBases.find((item) => item.reference === reference)?.name ?? reference}<button aria-label={`移除 ${reference}`} disabled={props.harnessRunning} onClick={() => props.onRemoveKnowledge(reference)} type="button"><X size={11} /></button></span>)}
        {props.localDirectories.map((directory) => <span className="local-context" key={directory.id}><FolderOpen size={12} />{directory.name}<button aria-label={`移除 ${directory.name}`} disabled={props.harnessRunning} onClick={() => props.onRemoveLocalDirectory(directory.id)} type="button"><X size={11} /></button></span>)}
        {props.pendingAttachments.length > 0 && <AttachmentList attachments={props.pendingAttachments} onRemove={props.onRemoveAttachment} />}
      </div>
    </div>
  </section>
}

function AttachmentList({ attachments, onRemove }: { attachments: LocalTaskAttachment[]; onRemove?: (id: string) => void }) {
  return <div className={`message-attachments${onRemove ? ' removable' : ''}`}>
    {attachments.map((attachment) => <span className="attachment-chip" key={attachment.id} title={`${attachment.rootName}/${attachment.path}`}>
      {attachment.kind === 'image' ? <FileImage size={14} /> : <FileText size={14} />}
      <span><strong>{attachment.name}</strong><small>{attachment.rootName}</small></span>
      {onRemove && <button aria-label={`移除 ${attachment.name}`} type="button" onClick={() => onRemove(attachment.id)}><X size={11} /></button>}
    </span>)}
  </div>
}

function knowledgeScopeLabel(scope: KnowledgeBaseEntry['scope']): string {
  return ({ PERSONAL: '个人', TEAM: '团队', ORGANIZATION: '公司' })[scope]
}
