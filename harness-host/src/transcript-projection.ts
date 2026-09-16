import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from './xiaoyin-projections-plugin.js'

/**
 * Product transcript projection. Folds the durable session log into the
 * conversation the employee sees: one entry per user turn and assistant turn,
 * with per-step text segments, tool cards, approvals and questions in event
 * order. The live wire view carries only the current turn so long sessions
 * stay under the projection bridge body cap; reload reads the full fold.
 *
 * Streaming note: `text-chunks` is a live notification, never a session log
 * event. This projection settles text per step from `assistant/message`; the
 * desktop overlays live deltas on the open segment and lets the settled value
 * win. Both paths therefore agree at every step boundary.
 */

export type TranscriptSegment =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'tool'; id: string; toolName: string; status: 'running' | 'completed' | 'failed' | 'canceled'
      startedAt: string; completedAt?: string; label: string; detail?: string; command?: string
      path?: string; secondaryPath?: string; itemCount?: number; output?: string }
  | { kind: 'approval'; id: string; approvalId: string; toolName: string; label: string
      status: 'running' | 'completed' | 'failed'; detail?: string }
  | { kind: 'question'; id: string; questionId: string; label: string
      questions: Array<Record<string, unknown>>; status: 'running' | 'completed' }

export interface TranscriptUserTurn {
  id: string
  role: 'user'
  text: string
}

export interface TranscriptAssistantTurn {
  id: string
  role: 'assistant'
  status: 'streaming' | 'completed' | 'failed' | 'canceled'
  segments: TranscriptSegment[]
  startedAt?: string
  completedAt?: string
  failure?: { kind: string; message: string }
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

export type TranscriptEntry = TranscriptUserTurn | TranscriptAssistantTurn

export interface TranscriptState {
  entries: TranscriptEntry[]
  toolNames: Record<string, string>
  lastSeq?: number
}

/** Wire view: only the current (or most recent) assistant turn, bounded in size. */
export interface TranscriptTurnView {
  turn: TranscriptAssistantTurn | null
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap { 'xiaoyin.transcript': TranscriptTurnView }
  interface SessionProjectionStateMap { 'xiaoyin.transcript': TranscriptState }
}

export const name = 'xiaoyin-transcript-projection'
export const inject = ['sessionProjections']

const jsonSchema = z.any() as never

export const initialTranscriptState = (): TranscriptState => ({ entries: [], toolNames: {} })

export function apply(ctx: Context): void {
  const definition: ProjectionDefinition<'xiaoyin.transcript', TranscriptState> = {
    key: 'xiaoyin.transcript',
    stateSchema: jsonSchema,
    stateVersion: 1,
    init: () => initialTranscriptState(),
    apply: (state, event) => {
      const next = reduceTranscriptEvent(state, event)
      return next === state ? state : next
    },
    wire: { viewSchema: jsonSchema, view: (state) => ({ turn: currentAssistantTurn(state) }) },
  }
  ;(ctx.sessionProjections as unknown as { register(value: unknown): () => void }).register(definition)
}

export function currentAssistantTurn(state: TranscriptState): TranscriptAssistantTurn | null {
  const last = state.entries.at(-1)
  return last && last.role === 'assistant' ? last : null
}

export function reduceTranscriptEvent(state: TranscriptState, event: SessionEvent): TranscriptState {
  const seq = sequence(event.seq)
  if (seq !== undefined && seq <= (state.lastSeq ?? -1)) return state
  const next = reduceTranscriptEventValue(state, event)
  return seq === undefined ? next : { ...next, lastSeq: seq }
}

function reduceTranscriptEventValue(state: TranscriptState, event: SessionEvent): TranscriptState {
  const data = record(event.data)
  const time = eventTime(event.time)
  const turn = number(data?.turn) ?? 0
  const step = number(data?.step) ?? 0

  if (event.type === 'user/message') {
    const message = record(data)
    // Only direct human prompts become bubbles. Injected context (file-change
    // notices, skill content, cron notifications) shares this event type and
    // must stay invisible in the transcript.
    if (record(message?.source)?.kind !== 'user') return state
    const promptText = textBlocks(message?.content)
    if (!promptText.trim()) return state
    const entry: TranscriptUserTurn = { id: text(message?.id) ?? `user:${state.entries.length}`, role: 'user', text: promptText }
    const open = openAssistantTurn(state)
    // The claimed prompt is logged after turn/start but before any content:
    // it belongs above the turn it drives. A mid-turn steer arrives after
    // visible segments and is embedded in the open turn between them.
    if (open && open.segments.length > 0) {
      return withTurn(state, { ...open, segments: [...open.segments, { kind: 'user', id: entry.id, text: promptText }] })
    }
    const index = open ? state.entries.length - 1 : state.entries.length
    const entries = [...state.entries.slice(0, index), entry, ...state.entries.slice(index)]
    return { ...state, entries }
  }

  if (event.type === 'turn/start') {
    // A previous turn still open means the log was cut before its turn/end;
    // settle it honestly instead of leaving it streaming forever.
    const open = openAssistantTurn(state)
    const settled = open ? [...state.entries.slice(0, -1), settleTurn(open, 'failed', time)] : state.entries
    const entry: TranscriptAssistantTurn = { id: `turn:${turn}`, role: 'assistant', status: 'streaming', segments: [], startedAt: time }
    return { ...state, entries: [...settled, entry] }
  }

  if (event.type === 'assistant/message') {
    const open = openAssistantTurn(state)
    if (!open) return state
    const message = record(data?.message)
    const messageText = textBlocks(message?.content)
    const segmentId = `${turn}:${step}`
    const withoutSegment = open.segments.filter((segment) => !(segment.kind === 'text' && segment.id === segmentId))
    const segments = messageText.trim()
      ? [...withoutSegment, { kind: 'text' as const, id: segmentId, text: messageText }]
      : withoutSegment
    const usage = addUsage(open.tokenUsage, data?.usage)
    return withTurn(state, { ...open, segments, ...(usage ? { tokenUsage: usage } : {}) })
  }

  if (event.type === 'tool/call') {
    const callId = text(data?.callId)
    const toolName = text(data?.name)
    if (!callId || !toolName) return state
    const open = openAssistantTurn(state)
    if (!open) return state
    const segment = { kind: 'tool' as const, id: `tool:${callId}`, toolName, status: 'running' as const, startedAt: time, ...toolPresentation(toolName, data?.arguments) }
    const segments = upsertSegment(open.segments, segment)
    return { ...withTurn(state, { ...open, segments }), toolNames: { ...state.toolNames, [callId]: toolName } }
  }

  if (event.type === 'tool/result') {
    const block = toolResultBlock(data)
    const callId = text(block?.toolCallId)
    if (!callId) return state
    const open = openAssistantTurn(state)
    if (!open) return state
    const failed = block?.isError === true || Boolean(data?.error)
    const segmentId = `tool:${callId}`
    const segments = open.segments.some((segment) => segment.id === segmentId)
      ? open.segments.map((segment) => segment.id === segmentId && segment.kind === 'tool'
        ? { ...segment, status: failed ? 'failed' as const : 'completed' as const, completedAt: time, ...toolResultPresentation(segment.toolName, block?.content, failed) }
        : segment)
      : open.segments
    return { ...withTurn(state, { ...open, segments }), toolNames: removeToolName(state.toolNames, callId) }
  }

  if (event.type === 'approval/request') {
    const approvalId = text(data?.approvalId)
    const toolName = text(data?.name)
    if (!approvalId || !toolName) return state
    const open = openAssistantTurn(state)
    if (!open) return state
    const reason = boundedText(data?.reason, 2_000)
    const segment = {
      kind: 'approval' as const, id: `approval:${approvalId}`, approvalId, toolName,
      label: `需要确认：${toolName}`, status: 'running' as const,
      ...(reason ? { detail: reason } : {}),
    }
    return withTurn(state, { ...open, segments: upsertSegment(open.segments, segment) })
  }

  if (event.type === 'approval/decision') {
    const approvalId = text(data?.approvalId)
    const decision = text(data?.decision)
    if (!approvalId || !['allow', 'reject'].includes(decision ?? '')) return state
    const open = openAssistantTurn(state)
    if (!open) return state
    const segments = open.segments.map((segment) => segment.kind === 'approval' && segment.approvalId === approvalId
      ? { ...segment, status: decision === 'allow' ? 'completed' as const : 'failed' as const, label: `${decision === 'allow' ? '已允许' : '已拒绝'}：${segment.toolName}` }
      : segment)
    return withTurn(state, { ...open, segments })
  }

  if (event.type === 'question/request') {
    const questionId = text(data?.questionId)
    const questions = questionsFromValue(data?.questions)
    if (!questionId || questions.length === 0) return state
    const open = openAssistantTurn(state)
    if (!open) return state
    const segment = { kind: 'question' as const, id: `question:${questionId}`, questionId, label: '需要你的回答', questions, status: 'running' as const }
    return withTurn(state, { ...open, segments: upsertSegment(open.segments, segment) })
  }

  if (event.type === 'question/answered') {
    const questionId = text(data?.questionId)
    if (!questionId) return state
    const open = openAssistantTurn(state)
    if (!open) return state
    const segments = open.segments.map((segment) => segment.kind === 'question' && segment.questionId === questionId
      ? { ...segment, status: 'completed' as const }
      : segment)
    return withTurn(state, { ...open, segments })
  }

  if (event.type === 'turn/end') {
    const open = openAssistantTurn(state)
    if (!open) return state
    const reason = record(data?.reason)
    const kind = text(reason?.kind) ?? 'unknown'
    const status = kind === 'completed' ? 'completed' : kind === 'aborted' ? 'canceled' : 'failed'
    const failure = status === 'failed' ? { kind, message: turnFailureMessage(reason) } : undefined
    const settled = settleTurn(open, status, time)
    return withTurn(state, failure ? { ...settled, failure } : settled)
  }

  return state
}

function openAssistantTurn(state: TranscriptState): TranscriptAssistantTurn | undefined {
  const last = state.entries.at(-1)
  return last?.role === 'assistant' && last.status === 'streaming' ? last : undefined
}

function withTurn(state: TranscriptState, turn: TranscriptAssistantTurn): TranscriptState {
  const last = state.entries.at(-1)
  if (!last || last.role !== 'assistant' || last.id !== turn.id) return { ...state, entries: [...state.entries, turn] }
  return { ...state, entries: [...state.entries.slice(0, -1), turn] }
}

function settleTurn(turn: TranscriptAssistantTurn, status: TranscriptAssistantTurn['status'], time: string): TranscriptAssistantTurn {
  return {
    ...turn,
    status,
    completedAt: time,
    segments: turn.segments.map((segment) => segment.kind === 'tool' && segment.status === 'running'
      ? { ...segment, status: status === 'completed' ? 'completed' : 'canceled', completedAt: time }
      : segment),
  }
}

function turnFailureMessage(reason: Record<string, unknown> | undefined): string {
  const kind = text(reason?.kind) ?? 'unknown'
  if (kind === 'max-tokens') return '本轮达到模型输出上限，结果尚未完成，请继续处理剩余内容'
  if (kind === 'blocked') return '本轮输入未进入执行，请检查权限或运行状态后重试'
  if (kind === 'interrupted') return '本轮执行被意外中断，已保留中断前的部分结果，请检查后继续'
  const error = record(reason?.error) ?? record(reason?.failure)
  const message = text(error?.message) ?? ''
  return message || '本轮执行失败，已保留部分结果，请检查后继续'
}

function addUsage(current: TranscriptAssistantTurn['tokenUsage'], value: unknown): TranscriptAssistantTurn['tokenUsage'] {
  const usage = record(value)
  const inputTokens = number(usage?.inputTokens)
  const outputTokens = number(usage?.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return current
  const cacheReadTokens = number(usage?.cacheReadTokens)
  const cacheWriteTokens = number(usage?.cacheWriteTokens)
  return {
    inputTokens: (current?.inputTokens ?? 0) + inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens: (current?.cacheReadTokens ?? 0) + cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + cacheWriteTokens } : {}),
  }
}

function upsertSegment(segments: TranscriptSegment[], segment: TranscriptSegment): TranscriptSegment[] {
  const index = segments.findIndex((item) => item.id === segment.id)
  if (index < 0) return [...segments, segment]
  return segments.map((item, current) => current === index ? { ...item, ...segment } as TranscriptSegment : item)
}

function toolResultBlock(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const content = record(data?.message)?.content
  if (!Array.isArray(content)) return undefined
  return content.find((item) => record(item) && typeof (item as Record<string, unknown>).toolCallId === 'string') as Record<string, unknown> | undefined
}

type ToolSegment = Extract<TranscriptSegment, { kind: 'tool' }>

function toolResultPresentation(toolName: string, content: unknown, failed: boolean): Partial<ToolSegment> {
  const value = toolResultValue(content)
  const output = toolResultText(content)
  if (failed) return compact({ detail: boundedText(publicErrorText(content) ?? output, 2_000) }) as Partial<ToolSegment>
  if (toolName === 'bash' || toolName === 'pwsh') {
    const exitCode = output.match(/\[exit code: (\d+)]\s*$/)?.[1]
    return compact({ output: boundedText(output.replace(/\n?\[exit code: \d+]\s*$/, '').trim(), 12_000), ...(exitCode !== undefined ? { detail: `退出码 ${exitCode}` } : {}) }) as Partial<ToolSegment>
  }
  if (toolName === 'local_files_list' && value) {
    const count = Array.isArray(value.entries) ? value.entries.length : 0
    return compact({ path: text(value.directory), itemCount: count, detail: `${count} 项${value.truncated === true ? '（仅显示部分）' : ''}` }) as Partial<ToolSegment>
  }
  if (toolName === 'local_files_search' && value) {
    const count = Array.isArray(value.matches) ? value.matches.length : 0
    return compact({ path: text(value.directory), itemCount: count, detail: `找到 ${count} 项${value.truncated === true ? '（仅显示部分）' : ''}` }) as Partial<ToolSegment>
  }
  if (toolName.startsWith('local_files_') || toolName.startsWith('office_')) {
    if (!value) return {}
    const size = number(value.size)
    return compact({
      path: text(value.path) ?? text(value.source),
      ...(text(value.destination) ? { secondaryPath: text(value.destination) } : {}),
      ...(size !== undefined ? { detail: formatBytes(size) } : {}),
    }) as Partial<ToolSegment>
  }
  return {}
}

/** Drop undefined values so optional properties stay absent, never explicit nulls. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function toolPresentation(toolName: string, rawArguments: unknown): Pick<ToolSegment, 'label' | 'detail' | 'command' | 'path' | 'secondaryPath'> {
  const args = recordValue(rawArguments)
  const path = text(args?.path) ?? text(args?.workdir)
  const destination = text(args?.destinationPath)
  if (toolName === 'bash' || toolName === 'pwsh') return compact({
    label: '运行命令', detail: text(args?.description), path,
    command: boundedText(text(args?.command), 16_000),
  }) as Pick<ToolSegment, 'label' | 'detail' | 'command' | 'path' | 'secondaryPath'>
  if (toolName.startsWith('subagent')) return { label: text(args?.description) ?? '委派子任务' }
  if (toolName === 'web_search' || toolName === 'web_fetch') return compact({
    label: toolActivityLabel(toolName), detail: text(args?.query) ?? text(args?.url),
  }) as Pick<ToolSegment, 'label' | 'detail' | 'command' | 'path' | 'secondaryPath'>
  const fileLabels: Record<string, string> = {
    local_files_roots: '检查可用工作目录',
    local_files_list: path ? `查看 ${path === '.' ? '目录' : path}` : '查看目录',
    local_files_search: `搜索“${text(args?.query) ?? '文件'}”`,
    local_files_read_text: path ? `读取 ${path}` : '读取文件',
    local_files_publish: path ? `准备交付 ${path}` : '准备交付文件',
    local_files_write_text: path ? `写入 ${path}` : '写入文件',
    local_files_create_directory: path ? `创建 ${path}` : '创建文件夹',
    local_files_copy: destination ? `复制到 ${destination}` : '复制文件',
    local_files_move: destination ? `移动到 ${destination}` : '移动文件',
    local_files_delete: path ? `删除 ${path}` : '删除文件',
    office_document_read: path ? `读取 ${path}` : '读取 Office 文档',
    office_docx_create: path ? `生成 ${path}` : '生成 Word 文档',
    office_xlsx_create: path ? `生成 ${path}` : '生成 Excel 表格',
    office_xlsx_update_cells: path ? `修改 ${path}` : '修改 Excel 表格',
    office_xlsx_append_rows: path ? `追加数据到 ${path}` : '追加 Excel 数据',
    office_xlsx_add_sheet: path ? `添加工作表到 ${path}` : '添加 Excel 工作表',
    office_xlsx_format_sheet: path ? `调整 ${path} 的排版` : '调整表格排版',
    office_pptx_create: path ? `生成 ${path}` : '生成 PowerPoint 演示文稿',
    office_pdf_create: path ? `生成 ${path}` : '生成 PDF 文档',
    office_document_export_pdf: path ? `将 ${path} 导出为 PDF 副本` : '导出 PDF 副本',
    office_xlsx_recalculate: path ? `重算 ${path} 并保存副本` : '重算表格副本',
  }
  if (fileLabels[toolName]) return compact({
    label: fileLabels[toolName], path: text(args?.path) ?? text(args?.sourcePath), secondaryPath: destination,
  }) as Pick<ToolSegment, 'label' | 'detail' | 'command' | 'path' | 'secondaryPath'>
  if (toolName.startsWith('terminal_')) return compact({
    label: toolActivityLabel(toolName), detail: text(args?.description) ?? text(args?.input) ?? text(args?.command),
  }) as Pick<ToolSegment, 'label' | 'detail' | 'command' | 'path' | 'secondaryPath'>
  if (toolName.startsWith('browser_')) return compact({
    label: toolActivityLabel(toolName), detail: text(args?.url),
  }) as Pick<ToolSegment, 'label' | 'detail' | 'command' | 'path' | 'secondaryPath'>
  if (toolName.startsWith('mcp_')) return { label: `使用 ${connectorNameFromTool(toolName)}` }
  return { label: toolActivityLabel(toolName) }
}

function toolActivityLabel(toolName: string): string {
  const known = ({
    skill: '加载专家技能',
    knowledge_list: '读取知识库目录',
    knowledge_search: '检索企业知识库',
    'office.document.read': '读取 Office 文档',
    'office.docx.create': '生成 Word 文档',
    'office.xlsx.create': '生成 Excel 表格',
    'office.pdf.create': '生成 PDF 文档',
    office_document_read: '读取 Office 文档',
    office_document_check: '检查交付文档',
    office_engine_status: '检查文档转换能力',
    office_document_export_pdf: '导出 PDF 副本',
    office_xlsx_recalculate: '重算表格副本',
    office_pdf_page: '查看 PDF 页面',
    computer_use_observe: '观察桌面', computer_use_click: '点击应用', computer_use_type: '输入文字',
    computer_use_key: '发送按键', computer_use_scroll: '滚动界面',
    local_files_roots: '检查工作目录',
    local_files_list: '查看目录内容',
    local_files_search: '搜索本地文件',
    local_files_read_text: '读取本地文件',
    local_files_publish: '准备交付文件',
    present: '声明交付文件',
    local_files_write_text: '修改本地文件',
    local_files_create_directory: '新建文件夹',
    local_files_copy: '复制本地文件',
    local_files_move: '移动本地文件',
    local_files_delete: '删除本地文件',
    bash: '运行 Bash 命令',
    pwsh: '运行 PowerShell 命令',
    terminal_open: '打开持久终端',
    terminal_send: '发送终端命令',
    terminal_read: '读取终端输出',
    terminal_signal: '控制终端进程',
    terminal_close: '关闭持久终端',
    terminal_list: '查看持久终端',
    job_output: '读取后台任务',
    job_list: '查看后台任务',
    job_kill: '停止后台任务',
    schedule_create: '创建会话提醒',
    schedule_list: '查看会话提醒',
    schedule_delete: '取消会话提醒',
    schedules_list: '查询定时任务',
    schedules_create: '创建定时任务',
    schedules_update: '修改定时任务',
    schedules_pause: '暂停定时任务',
    schedules_resume: '恢复定时任务',
    schedules_delete: '删除定时任务',
    todo_write: '更新任务清单',
    workflow: '执行工作流',
    web_search: '搜索网页资料',
    web_fetch: '读取网页内容',
    exit_plan_mode: '提交计划审阅',
    get_goal: '查看任务目标',
    task_report: '整理交付结果',
    create_goal: '创建任务目标',
    update_goal: '更新任务目标',
    session_search: '查询历史会话',
    session_event_search: '查询会话事件',
    session_trace: '查看会话关系',
    session_event_trace: '查看事件关系',
    session_event_read: '读取会话事件',
    list_agents: '查看子 Agent',
    subagent: '委派子任务',
    browser_open: '打开网页',
    browser_snapshot: '读取网页',
    browser_click: '操作网页',
    browser_click_text: '操作网页',
    browser_click_point: '操作网页',
    browser_type: '填写网页内容',
    browser_press_key: '操作网页键盘',
    browser_wait_for: '等待网页内容',
    browser_reload: '刷新网页',
    browser_downloads: '查看下载文件',
  } as Record<string, string>)[toolName]
  if (known) return known
  if (toolName.startsWith('mcp_')) return `使用 ${connectorNameFromTool(toolName)} 连接器`
  return `调用 ${toolName}`
}

function connectorNameFromTool(toolName: string): string {
  return toolName.slice(4).split('_')[0] || '连接器'
}

function toolResultValue(content: unknown): Record<string, unknown> | undefined {
  const blocks = Array.isArray(content) ? content : []
  for (const block of blocks) {
    const item = record(block)
    const value = text(item?.text)
    if (!value) continue
    try {
      const parsed: unknown = JSON.parse(value)
      const parsedRecord = record(parsed)
      if (parsedRecord) return parsedRecord
    } catch { /* human-readable tool output is not a product receipt */ }
  }
  return undefined
}

function toolResultText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : []
  return blocks.map((block) => text(record(block)?.text) ?? '').join('')
}

function publicErrorText(content: unknown): string | undefined {
  const value = toolResultValue(content)
  return boundedText(text(value?.error) ?? text(value?.message), 2_000)
}

function textBlocks(content: unknown): string {
  const blocks = Array.isArray(content) ? content : []
  return blocks.map((block) => text(record(block)?.text) ?? '').join('')
}

function questionsFromValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const question = record(entry)
    if (!question) return []
    const id = boundedText(question.id, 200)
    const prompt = boundedText(question.question, 4_000)
    if (!id || !prompt) return []
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 12).flatMap((option) => {
          const item = record(option)
          const label = boundedText(item?.label, 500)
          return item && label ? [{ label, ...(boundedText(item.description, 1_000) ? { description: boundedText(item.description, 1_000) } : {}) }] : []
        })
      : undefined
    return [{ id, question: prompt, ...(boundedText(question.header, 200) ? { header: boundedText(question.header, 200) } : {}), ...(boundedText(question.detail, 64 * 1024) ? { detail: boundedText(question.detail, 64 * 1024) } : {}), ...(options?.length ? { options } : {}), ...(question.multiSelect === true ? { multiSelect: true } : {}) }]
  })
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function eventTime(value: unknown): string {
  const date = new Date(typeof value === 'number' ? value : Number.NaN)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value)) } catch { return undefined }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function sequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function removeToolName(toolNames: Record<string, string>, callId: string): Record<string, string> {
  return Object.hasOwn(toolNames, callId) ? Object.fromEntries(Object.entries(toolNames).filter(([id]) => id !== callId)) : toolNames
}
