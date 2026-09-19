import type { ToolSegment } from '../conversation/types'

/** Classify actual tools, never infer file edits or web searches from prose. */
export function toolActionLabel(toolName: string): string {
  const tool = toolName.replaceAll('.', '_')
  const known: Record<string, string> = {
    skill: '加载技能',
    local_files_roots: '查看目录', local_files_list: '查看目录', local_files_search: '搜索文件',
    local_files_read_text: '读取文件', office_document_read: '读取文件',
    office_document_check: '检查文档结构', office_pdf_page: '查看 PDF 页面',
    office_engine_status: '检查转换能力', office_document_export_pdf: '导出 PDF 副本', office_xlsx_recalculate: '重算表格副本',
    local_files_write_text: '编辑文件', office_xlsx_update_cells: '编辑表格',
    office_xlsx_append_rows: '编辑表格', office_xlsx_add_sheet: '编辑表格',
    office_xlsx_format_sheet: '调整表格排版',
    local_files_publish: '准备交付文件', local_files_copy: '复制文件', local_files_move: '移动文件',
    local_files_delete: '删除文件', local_files_create_directory: '创建目录',
    office_docx_create: '生成文档', office_xlsx_create: '生成表格',
    office_pptx_create: '生成演示文稿', office_pdf_create: '生成 PDF',
    bash: '运行命令', pwsh: '运行命令',
    job_output: '读取命令输出', job_list: '查看后台任务', job_kill: '停止后台任务',
    browser_open: '打开网页', browser_snapshot: '读取网页', browser_screenshot: '截取网页',
    browser_downloads: '查看下载文件', browser_human_takeover: '等待浏览器操作',
    knowledge_search: '检索知识库', knowledge_list: '查看知识库',
    computer_use_observe: '查看桌面', computer_use_click: '点击应用', computer_use_type: '输入文字',
    computer_use_key: '发送按键', computer_use_scroll: '滚动界面',
  }
  return known[tool] ?? '调用工具'
}

/** One-line summary of a run of tool cards, Claude Code style. */
export function toolGroupLabel(tools: ToolSegment[]): string {
  if (!tools.length) return '暂无操作'
  const meaningful = tools.filter((tool) => tool.toolName !== 'tool_discover' && tool.toolName !== 'task_report')
  const running = meaningful.filter((tool) => tool.status === 'running')
  const completed = meaningful.filter((tool) => tool.status === 'completed')
  const failed = tools.filter((tool) => tool.status === 'failed').length
  const canceled = tools.filter((tool) => tool.status === 'canceled').length
  const parts: string[] = []
  if (failed) parts.push(`${failed} 个操作失败`)
  if (canceled) parts.push(`${canceled} 个操作已停止`)
  const active = [...new Set(running.map((tool) => toolActionLabel(tool.toolName)))]
  if (active.length) parts.push(...active.slice(0, 2).map((action) => `正在${action}`))
  const actions = [...new Set(completed.map((tool) => toolActionLabel(tool.toolName)))]
  const notable = actions.length > 1 ? actions.filter((action) => action !== '查看目录') : actions
  parts.push(...notable.filter((action) => !active.includes(action)).slice(0, Math.max(0, 3 - parts.length)).map((action) => `已${action}`))
  return parts.join(' · ') || (tools.some((tool) => tool.status === 'running') ? '正在准备任务' : '执行记录')
}

export function toolGroupStatus(tools: ToolSegment[]): string {
  const completed = tools.filter((tool) => tool.status === 'completed').length
  const failed = tools.filter((tool) => tool.status === 'failed').length
  const canceled = tools.filter((tool) => tool.status === 'canceled').length
  return [`共 ${tools.length} 次操作`, `完成 ${completed}`, failed ? `失败 ${failed}` : '', canceled ? `停止 ${canceled}` : '',
    tools.some((tool) => tool.status === 'running') ? '执行中' : ''].filter(Boolean).join(' · ')
}

export type ToolCategory = 'read' | 'write' | 'command' | 'connector' | 'browser' | 'subagent' | 'tool'

/** Which kind of work a tool does, for the card icon and colour. */
export function toolCategory(toolName: string): ToolCategory {
  const tool = toolName.replaceAll('.', '_')
  if (tool.startsWith('mcp_') || tool.startsWith('knowledge_')) return 'connector'
  if (tool.startsWith('browser_') || tool === 'web_search' || tool === 'web_fetch') return 'browser'
  if (tool.startsWith('subagent')) return 'subagent'
  if (tool === 'bash' || tool === 'pwsh' || tool.startsWith('terminal_') || tool.startsWith('job_')) return 'command'
  if (tool === 'local_files_read_text' || tool === 'office_document_read' || tool === 'office_pdf_page'
    || tool === 'office_document_check' || tool === 'office_engine_status'
    || tool === 'local_files_list' || tool === 'local_files_roots' || tool === 'local_files_search'
    || tool === 'session_search' || tool === 'session_event_search' || tool === 'session_trace'
    || tool === 'session_event_trace' || tool === 'session_event_read' || tool === 'list_agents') return 'read'
  if (tool.startsWith('local_files_') || tool.startsWith('office_') || tool === 'present') return 'write'
  return 'tool'
}

/** Consecutive tool segments collapse into one card group. */
export function groupToolSegments<T extends { kind: string }>(segments: T[]): Array<{ kind: 'tools'; tools: ToolSegment[] } | { kind: 'other'; segment: T }> {
  const groups: Array<{ kind: 'tools'; tools: ToolSegment[] } | { kind: 'other'; segment: T }> = []
  for (const segment of segments) {
    if (segment.kind === 'tool') {
      const last = groups.at(-1)
      if (last?.kind === 'tools') last.tools.push(segment as unknown as ToolSegment)
      else groups.push({ kind: 'tools', tools: [segment as unknown as ToolSegment] })
    } else {
      groups.push({ kind: 'other', segment })
    }
  }
  return groups
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}分${seconds % 60}秒` : `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

export function turnDurationLabel(startedAt?: string, completedAt?: string): string {
  const elapsed = Date.parse(completedAt ?? '') - Date.parse(startedAt ?? '')
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return ''
  return formatDuration(Math.floor(elapsed / 1_000))
}

export function formatTokens(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count)
}
