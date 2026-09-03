import { ArrowDown, BookOpen, Bot, Check, ChevronDown, CirclePlus, CircleStop, FileImage, FileText, FolderOpen, Send, Sparkles, SquareCheckBig, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type RefObject, type UIEvent } from 'react'
import type { AuthorizedLocalDirectory } from './harness'
import type { InvocationOption } from './invocations'
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
  capabilitySnapshot?: CapabilitySnapshot
  harnessHealth: 'checking' | 'ready' | 'degraded'
  harnessHealthDetail: string
  harnessRunning: boolean
  runtimeStatus: RuntimeStatus
  selectedCapabilityExecutable: boolean
  selectedCapabilityName: string
  selectedCapabilityId: string
  capabilityOptions: Array<{ id: string; name: string; summary: string }>
  activeModel: string
  models: string[]
  modelMenuOpen: boolean
  visibleInvocations: InvocationOption[]
  contextQuery?: string
  visibleKnowledgeContexts: KnowledgeBaseEntry[]
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
  onRecoverHarness: () => void
  onAddLocalDirectory: () => void
  onSelectCapability: (id: string) => void
  onToggleModelMenu: () => void
  onSelectModel: (model: string) => void
  onCancel: () => void
  onSelectInvocation: (option: InvocationOption) => void
  onAddKnowledge: (reference: string) => void
  onRemoveKnowledge: (reference: string) => void
  onRemoveLocalDirectory: (id: string) => void
  onRemoveAttachment: (id: string) => void
}

export function ChatPage(props: Props) {
  const [showScrollDown, setShowScrollDown] = useState(false)
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
      const retryable = message.role === 'assistant' && index === props.messages.length - 1 && !message.pending
        && (monitor?.status === 'failed' || monitor?.status === 'canceled')
      if (message.role === 'user') return <article className="conversation-turn user-turn" key={`${message.role}-${index}`}>
        <div className="user-prompt">
          {message.attachments && message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
          <Suspense fallback={<p>{message.text}</p>}><RichMessage assistant={false} text={message.text} /></Suspense>
        </div>
      </article>
      return <article aria-busy={message.pending} className={`conversation-turn assistant-turn${message.pending ? ' pending' : ''}`} key={`${message.role}-${index}`}>
        {monitor && <InlineTaskActivity finalResponse={message.text} monitor={monitor} />}
        {(!message.pending || message.text) && <div className={message.pending ? 'streaming-response' : undefined}><Suspense fallback={<p>{message.text}</p>}><RichMessage assistant={!message.pending} onRegenerate={!message.pending && index === props.messages.length - 1 ? props.onPrepareRetry : undefined} text={message.text} /></Suspense></div>}
        {!message.pending && monitor && monitor.artifacts.length > 0 && <TaskArtifacts artifacts={monitor.artifacts} conversation />}
        {retryable && <button className="retry-task" onClick={props.onPrepareRetry} type="button">重试这个任务</button>}
      </article>
    })}</div>}
    {showScrollDown && <button aria-label="滚动到最新消息" className="scroll-to-latest" onClick={() => scrollToBottom()} title="滚动到最新消息" type="button"><ArrowDown size={18} /></button>}
    {props.harnessHealth === 'degraded' && <div className="runtime-recovery"><CircleStop size={17} /><span><strong>本地 Agent 暂不可用</strong><small>{props.harnessHealthDetail}</small></span><button onClick={props.onRecoverHarness} type="button">重新检测</button></div>}
    <form className="composer" onSubmit={props.onSubmit}>
      <textarea aria-label="给小胤发送消息" onChange={(event) => props.onPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="描述任务；@ 引用知识库，/ 使用快捷指令" ref={props.composerRef} value={props.prompt} />
      <div className="composer-actions">
        <div className="context-picker" ref={contextPickerRef}>
          <button aria-expanded={contextMenuOpen} className="workspace-button" disabled={props.harnessRunning} onClick={() => { setContextMenuOpen((value) => !value); setCapabilityMenuOpen(false) }} title="添加文件或知识库" type="button"><CirclePlus size={17} /><span>添加</span></button>
          {contextMenuOpen && <div className="composer-popover context-menu">
            <small>添加到当前任务</small>
            <button onClick={() => { setContextMenuOpen(false); props.onAddLocalDirectory() }} type="button"><FolderOpen size={16} /><span><strong>工作目录</strong><small>允许小胤读取和处理本地文件</small></span></button>
            {props.knowledgeBases.filter((item) => !props.selectedKnowledgeBaseRefs.includes(item.reference)).length > 0 && <>
              <small>知识库</small>
              {props.knowledgeBases.filter((item) => !props.selectedKnowledgeBaseRefs.includes(item.reference)).slice(0, 6).map((item) => <button disabled={Boolean(props.capabilitySnapshot)} key={item.reference} onClick={() => { props.onAddKnowledge(item.reference); setContextMenuOpen(false) }} type="button"><BookOpen size={16} /><span><strong>{item.name}</strong><small>{item.description || knowledgeScopeLabel(item.scope)}</small></span></button>)}
            </>}
          </div>}
        </div>
        <div className="capability-picker" ref={capabilityPickerRef}>
          <button aria-expanded={capabilityMenuOpen} className="mode-button" disabled={props.harnessRunning || Boolean(props.capabilitySnapshot)} onClick={() => { setCapabilityMenuOpen((value) => !value); setContextMenuOpen(false) }} title={props.capabilitySnapshot ? '当前对话的工作模式已固定，新建任务后可切换' : '选择工作模式'} type="button"><Sparkles size={14} /> {props.selectedCapabilityName} <ChevronDown size={13} /></button>
          {capabilityMenuOpen && <div className="composer-popover capability-menu">
            <small>工作模式</small>
            <button className={!props.selectedCapabilityId ? 'active' : ''} onClick={() => { props.onSelectCapability(''); setCapabilityMenuOpen(false) }} type="button"><Sparkles size={16} /><span><strong>通用</strong><small>小胤根据任务自动选择技能和工具</small></span>{!props.selectedCapabilityId && <Check size={15} />}</button>
            {props.capabilityOptions.length > 0 && <small>专家套件</small>}
            {props.capabilityOptions.map((option) => <button className={props.selectedCapabilityId === option.id ? 'active' : ''} key={option.id} onClick={() => { props.onSelectCapability(option.id); setCapabilityMenuOpen(false) }} type="button"><Sparkles size={16} /><span><strong>{option.name}</strong><small>{option.summary}</small></span>{props.selectedCapabilityId === option.id && <Check size={15} />}</button>)}
          </div>}
        </div>
        <div className="model-picker" ref={props.modelPickerRef}>
          <button aria-expanded={props.modelMenuOpen} className="model-label" onClick={props.onToggleModelMenu} type="button"><Bot size={14} /> {modelDisplayName(props.activeModel)} <ChevronDown size={13} /></button>
          {props.modelMenuOpen && <div className="model-menu"><small>公司可用模型</small>{(props.models.length ? props.models : [props.activeModel]).map((model) => <button className={model === props.activeModel ? 'active' : ''} key={model} onClick={() => props.onSelectModel(model)} type="button"><span><strong>{modelDisplayName(model)}</strong><small>{model}</small></span>{model === props.activeModel && <SquareCheckBig size={14} />}</button>)}</div>}
        </div>
        {props.harnessRunning
          ? <button aria-label="取消当前任务" className="cancel-button" onClick={props.onCancel} title="取消当前任务" type="button"><CircleStop size={17} /></button>
          : <button aria-label="发送" className="send-button" disabled={(!props.prompt.trim() && props.pendingAttachments.length === 0) || props.runtimeStatus !== 'ready' || props.harnessHealth === 'degraded' || !props.selectedCapabilityExecutable} title={props.runtimeStatus !== 'ready' ? '企业服务未连接' : props.harnessHealth === 'degraded' ? '请先恢复本地 Agent' : !props.selectedCapabilityExecutable ? '企业目录缓存已过期，请先重新同步' : '发送'} type="submit"><Send size={17} /></button>}
      </div>
      {props.visibleInvocations.length > 0 && <div className="slash-menu"><small>快捷指令</small>{props.visibleInvocations.map((option) => <button key={`${option.profileKind}-${option.profileId}-${option.id}`} onClick={() => props.onSelectInvocation(option)} type="button"><span><strong>{option.label}</strong><small>{option.description}</small></span></button>)}</div>}
      {props.contextQuery !== undefined && <div className="slash-menu"><small>引用知识库</small>{props.visibleKnowledgeContexts.map((item) => <button key={item.reference} onClick={() => props.onAddKnowledge(item.reference)} type="button"><span><strong>@{item.name}</strong><small>{item.description || item.reference}</small></span><em>{knowledgeScopeLabel(item.scope)}</em></button>)}{props.visibleKnowledgeContexts.length === 0 && <span className="context-menu-empty">{props.capabilitySnapshot ? '当前对话已开始，请新建任务后添加知识库' : '没有匹配的知识库'}</span>}</div>}
    </form>
    {props.localFileError && <div className="local-file-error">{props.localFileError}</div>}
    <div className="context-bar">
      <div className="local-contexts">
        {props.selectedKnowledgeBaseRefs.map((reference) => <span className="local-context" key={reference}>@{props.knowledgeBases.find((item) => item.reference === reference)?.name ?? reference}<button aria-label={`移除 ${reference}`} disabled={props.harnessRunning || Boolean(props.capabilitySnapshot)} onClick={() => props.onRemoveKnowledge(reference)} type="button"><X size={11} /></button></span>)}
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
