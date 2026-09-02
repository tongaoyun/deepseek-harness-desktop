import { Bot, Boxes, ChevronDown, CirclePlus, CircleStop, FolderOpen, Send, ShieldCheck, Sparkles, SquareCheckBig, Store, X } from 'lucide-react'
import { lazy, Suspense, type FormEvent, type RefObject } from 'react'
import type { AuthorizedLocalDirectory } from './harness'
import type { InvocationOption } from './invocations'
import { modelDisplayName } from './modelSelection'
import { TaskMonitor } from './TaskMonitor'
import type { CapabilitySnapshot, KnowledgeBaseEntry, RuntimeStatus, TaskMessage, TaskMonitorState } from './types'
import { XiaoyinMascot } from './XiaoyinMascot'

const RichMessage = lazy(() => import('./RichMessage').then((module) => ({ default: module.RichMessage })))
const starterTasks = [
  { icon: SquareCheckBig, title: '订单异常诊断', detail: '定位履约风险与待办', prompt: '分析昨天的订单异常，并给出处理优先级' },
  { icon: Boxes, title: '库存风险分析', detail: '识别缺货与滞销商品', prompt: '分析本周库存风险，列出需要补货的商品' },
  { icon: Store, title: 'Listing 优化', detail: '生成更专业的商品内容', prompt: '帮我优化这个商品的 Listing 内容' },
]

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
  activeModel: string
  models: string[]
  modelMenuOpen: boolean
  visibleInvocations: InvocationOption[]
  contextQuery?: string
  visibleKnowledgeContexts: KnowledgeBaseEntry[]
  knowledgeBases: KnowledgeBaseEntry[]
  selectedKnowledgeBaseRefs: string[]
  localDirectories: AuthorizedLocalDirectory[]
  localFileError: string
  messageListRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<HTMLTextAreaElement | null>
  modelPickerRef: RefObject<HTMLDivElement | null>
  onPrompt: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onPrepareRetry: () => void
  onRecoverHarness: () => void
  onAddLocalDirectory: () => void
  onCapabilityPage: () => void
  onToggleModelMenu: () => void
  onSelectModel: (model: string) => void
  onCancel: () => void
  onSelectInvocation: (option: InvocationOption) => void
  onAddKnowledge: (reference: string) => void
  onRemoveKnowledge: (reference: string) => void
  onRemoveLocalDirectory: (id: string) => void
}

export function ChatPage(props: Props) {
  return <section className={props.messages.length > 0 ? 'chat-page conversation' : 'chat-page'}>
    {props.messages.length === 0 && <div className="hero-copy">
      <XiaoyinMascot size={82} variant="hero" />
      <div className="hero-greeting">嗨，我是小胤</div>
      <h1>今天想先处理什么？</h1>
      <p>连接 ERP 数据，让专家 Agent 安全地完成查询、分析与内容生产</p>
      <div className="starter-actions">{starterTasks.map(({ icon: Icon, title, detail, prompt }) => <button key={title} onClick={() => props.onPrompt(prompt)} type="button"><Icon size={16} /><span><strong>{title}</strong><small>{detail}</small></span></button>)}</div>
    </div>}
    {props.messages.length > 0 && <div className="message-list" ref={props.messageListRef}>{props.messages.map((message, index) => {
      const retryable = message.role === 'assistant' && index === props.messages.length - 1 && !message.pending && (message.text.startsWith('执行失败：') || message.text.startsWith('任务已取消'))
      const visibleText = message.pending ? props.taskMonitor.activity : message.text
      return <article className={`message ${message.role}${message.pending ? ' pending' : ''}`} key={`${message.role}-${index}`}><span className="message-avatar">{message.role === 'user' ? '你' : <XiaoyinMascot size={29} variant="avatar" />}</span><div><small>{message.role === 'user' ? '你' : '小胤'}</small><Suspense fallback={<p>{visibleText}</p>}><RichMessage assistant={message.role === 'assistant'} onRegenerate={message.role === 'assistant' && !message.pending ? props.onPrepareRetry : undefined} text={visibleText} /></Suspense>{retryable && <button className="retry-task" onClick={props.onPrepareRetry} type="button">修改后重新执行</button>}</div></article>
    })}</div>}
    {props.messages.length > 0 && <TaskMonitor capabilitySnapshot={props.capabilitySnapshot} monitor={props.taskMonitor} />}
    {props.harnessHealth === 'degraded' && <div className="runtime-recovery"><CircleStop size={17} /><span><strong>本地 Agent 暂不可用</strong><small>{props.harnessHealthDetail}</small></span><button onClick={props.onRecoverHarness} type="button">重新检测</button></div>}
    <form className="composer" onSubmit={props.onSubmit}>
      <textarea aria-label="给小胤发送消息" onChange={(event) => props.onPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="描述任务，/ 选择专家套件或技能，@ 添加业务上下文" ref={props.composerRef} value={props.prompt} />
      <div className="composer-actions">
        <button aria-label="授权本地文件夹" className="circle-button" disabled={props.harnessRunning} onClick={props.onAddLocalDirectory} title="授权本地文件夹" type="button"><CirclePlus size={18} /></button>
        <button className="mode-button" onClick={props.onCapabilityPage} type="button"><Sparkles size={14} /> {props.selectedCapabilityName} <ChevronDown size={13} /></button>
        <div className="model-picker" ref={props.modelPickerRef}>
          <button aria-expanded={props.modelMenuOpen} className="model-label" onClick={props.onToggleModelMenu} type="button"><Bot size={14} /> {modelDisplayName(props.activeModel)} <ChevronDown size={13} /></button>
          {props.modelMenuOpen && <div className="model-menu"><small>公司可用模型</small>{(props.models.length ? props.models : [props.activeModel]).map((model) => <button className={model === props.activeModel ? 'active' : ''} key={model} onClick={() => props.onSelectModel(model)} type="button"><span><strong>{modelDisplayName(model)}</strong><small>{model}</small></span>{model === props.activeModel && <SquareCheckBig size={14} />}</button>)}</div>}
        </div>
        {props.harnessRunning
          ? <button aria-label="取消当前任务" className="cancel-button" onClick={props.onCancel} title="取消当前任务" type="button"><CircleStop size={17} /></button>
          : <button aria-label="发送" className="send-button" disabled={!props.prompt.trim() || props.runtimeStatus !== 'ready' || props.harnessHealth === 'degraded' || !props.selectedCapabilityExecutable} title={props.runtimeStatus !== 'ready' ? '企业服务未连接' : props.harnessHealth === 'degraded' ? '请先恢复本地 Agent' : !props.selectedCapabilityExecutable ? '企业目录缓存已过期，请先重新同步' : '发送'} type="submit"><Send size={17} /></button>}
      </div>
      {props.visibleInvocations.length > 0 && <div className="slash-menu"><small>快捷调用</small>{props.visibleInvocations.map((option) => <button key={`${option.kind}-${option.profileId}-${option.id}`} onClick={() => props.onSelectInvocation(option)} type="button"><span><strong>{option.label}</strong><small>{option.description}</small></span><em>{option.profileName}</em></button>)}</div>}
      {props.contextQuery !== undefined && <div className="slash-menu"><small>添加业务上下文</small>{props.visibleKnowledgeContexts.map((item) => <button key={item.reference} onClick={() => props.onAddKnowledge(item.reference)} type="button"><span><strong>@{item.name}</strong><small>{item.description || item.reference}</small></span><em>{knowledgeScopeLabel(item.scope)}</em></button>)}{props.visibleKnowledgeContexts.length === 0 && <span className="context-menu-empty">{props.capabilitySnapshot ? '当前任务能力已固定，请新建任务后添加' : '没有匹配的可用知识库'}</span>}</div>}
    </form>
    {props.localFileError && <div className="local-file-error">{props.localFileError}</div>}
    <div className="context-bar">
      <div className="local-contexts">
        {props.selectedKnowledgeBaseRefs.map((reference) => <span className="local-context" key={reference}>@{props.knowledgeBases.find((item) => item.reference === reference)?.name ?? reference}<button aria-label={`移除 ${reference}`} disabled={props.harnessRunning || Boolean(props.capabilitySnapshot)} onClick={() => props.onRemoveKnowledge(reference)} type="button"><X size={11} /></button></span>)}
        {props.localDirectories.length === 0
          ? <span>{props.capabilitySnapshot ? `${props.capabilitySnapshot.extensions.length} 个扩展 · ${props.capabilitySnapshot.connectors.length} 个连接器 · 本任务能力已固定` : '已启用连接器将在发送首条消息时固定到本任务'} · 本地文件未授权</span>
          : props.localDirectories.map((directory) => <span className="local-context" key={directory.id}><FolderOpen size={12} />{directory.name}<button aria-label={`移除 ${directory.name}`} disabled={props.harnessRunning} onClick={() => props.onRemoveLocalDirectory(directory.id)} type="button"><X size={11} /></button></span>)}
      </div>
      <span><ShieldCheck size={14} /> 仅访问已授权目录 · 修改与 Shell 逐次确认</span>
    </div>
  </section>
}

function knowledgeScopeLabel(scope: KnowledgeBaseEntry['scope']): string {
  return ({ PERSONAL: '个人', TEAM: '团队', ORGANIZATION: '公司' })[scope]
}
