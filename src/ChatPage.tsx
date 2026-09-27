import { useEffect, useState, type FormEvent, type RefObject } from 'react'
import type { AuthorizedLocalDirectory } from './harness'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import type { LocalArtifactTarget } from './localArtifactPreview'
import { TaskVisuals } from './TaskVisuals'
import type { ConversationEntry } from './conversation/types'
import type { CapabilitySnapshot, KnowledgeBaseEntry, LocalTaskAttachment, RuntimeStatus, XiaoyinTaskProjection } from './types'
import type { ExtensionInvocation } from './extensionInvocations'
import type { TaskQueue } from './useTaskQueue'
import type { HarnessHealth } from './useHarnessHealth'
import { OfficialConversationPanel } from './conversation/OfficialConversationPanel'
import { KnowledgeSources } from './KnowledgeSources'
import type { KnowledgeSourceContext } from './api'

export interface ChatPageProps {
  employeeId?: string
  sessionId?: string
  onResumeInterrupted?: () => void
  knowledgeContext?: KnowledgeSourceContext
  taskId?: string
  /** Product task fixture retained for queue orchestration; never rendered. */
  entries: ConversationEntry[]
  fileChangesBusy?: boolean
  onChangesUndone?: (results: import('./localArtifactPreview').UndoFileResult[]) => void
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
  onOfficialPrompt?: (value: string, sessionId?: string, mode?: 'queue' | 'steer', attachments?: LocalTaskAttachment[], requestId?: string) => void
  onOfficialRename?: (sessionId: string, title: string) => void
  onOfficialQueueUpdate?: (sessionId: string, itemId: string, action: { kind: 'remove' } | { kind: 'edit'; text: string } | { kind: 'steer' }) => void
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
  onApprovalDecision?: (approvalId: string, decision: 'allow' | 'reject') => void | Promise<void>
  onQuestionAnswer?: (questionId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>) => void | Promise<void>
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
  const [previewTargets, setPreviewTargets] = useState<LocalArtifactTarget[]>([])
  const [previewKey, setPreviewKey] = useState('')
  const previewTarget = previewTargets.find((target) => artifactKey(target) === previewKey) ?? previewTargets.at(-1)
  const openPreview = (target: LocalArtifactTarget) => {
    const key = artifactKey(target)
    setPreviewTargets((current) => current.some((item) => artifactKey(item) === key) ? current.map((item) => artifactKey(item) === key ? target : item) : [...current, target].slice(-8))
    setPreviewKey(key)
  }
  const closePreview = () => {
    setPreviewTargets([])
    setPreviewKey('')
  }

  useEffect(() => {
    setPreviewTargets([])
    setPreviewKey('')
  }, [props.taskId])

  return <div className={`chat-workspace${previewTarget ? ' preview-open' : ''}`}>
    <OfficialConversationPanel employeeId={props.employeeId} sessionId={props.sessionId} model={props.activeModel} sessionReferences={props.sessionReferences} onPrompt={props.onOfficialPrompt} onRename={props.onOfficialRename} onSelectModel={props.onSelectModel} onQueueUpdate={props.onOfficialQueueUpdate} onCancel={props.onCancel} />
    {props.runtimeStatus === 'offline' && <div className="runtime-recovery"><span><strong>企业服务暂不可用</strong><small>请检查内网连接后重试</small></span><button onClick={props.onReconnect} type="button">重新连接</button></div>}
    {props.harnessHealth === 'degraded' && <div className="runtime-recovery"><span><strong>本地 Agent 暂不可用</strong><small>{props.harnessHealthDetail}</small></span><button onClick={props.onRecoverHarness} type="button">重新检测</button></div>}
    {props.taskProjection.knowledgeSources && <KnowledgeSources sources={props.taskProjection.knowledgeSources} context={props.knowledgeContext} />}
    {props.taskProjection.visuals && props.employeeId && props.taskProjection.visuals.length > 0 && <TaskVisuals employeeId={props.employeeId} visuals={props.taskProjection.visuals} />}
    {previewTarget && <LocalFilePreviewPanel onClose={closePreview} onOpenSelected={openPreview} onSelect={(target) => setPreviewKey(artifactKey(target))} tabs={previewTargets} target={previewTarget} />}
  </div>
}

function artifactKey(target: LocalArtifactTarget): string { return `${target.rootId}:${target.path}` }
