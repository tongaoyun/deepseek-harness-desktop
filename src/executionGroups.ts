import type { TaskTimelineEntry } from './types'

export interface ExecutionGroup { id: string; kind: 'steps' | 'message' | 'notice'; entries: TaskTimelineEntry[] }
export function groupExecutionEntries(entries: TaskTimelineEntry[]): ExecutionGroup[] {
  const groups: ExecutionGroup[] = []
  for (const entry of entries) {
    const kind = entry.kind === 'assistant' ? 'message' : ['approval', 'question', 'error', 'warning'].includes(entry.kind) ? 'notice' : 'steps'
    const last = groups.at(-1)
    if (kind === 'steps' && last?.kind === 'steps') last.entries.push(entry)
    else groups.push({ id: entry.id, kind, entries: [entry] })
  }
  return groups
}

export function executionGroupLabel(entries: TaskTimelineEntry[]): string {
  if (!entries.length) return '暂无执行步骤'
  const running = entries.filter((entry) => entry.status === 'running')
  const completed = entries.filter((entry) => entry.status === 'completed')
  const failed = entries.filter((entry) => entry.status === 'failed').length
  const canceled = entries.filter((entry) => entry.status === 'canceled').length
  const parts: string[] = []
  if (failed) parts.push(`${failed} 个步骤失败`)
  if (canceled) parts.push(`${canceled} 个步骤已停止`)
  const active = [...new Set(running.map(executionAction))]
  if (active.length) parts.push(...active.slice(0, 2).map((action) => `正在${action}`))
  if (active.length > 2) parts.push(`另有 ${active.length - 2} 类操作进行中`)
  const actions = [...new Set(completed.map(executionAction))]
  parts.push(...actions.slice(0, 3).map((action) => `已${action}`))
  if (actions.length > 3) parts.push(`另有 ${actions.length - 3} 类操作完成`)
  return parts.join(' · ')
}

/** Classify actual tools, never infer file edits or web searches from prose/commands. */
export function executionAction(entry: TaskTimelineEntry): string {
  const tool = (entry.toolName ?? '').replaceAll('.', '_')
  const known: Record<string, string> = {
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
  if (known[tool]) return known[tool]
  if (entry.kind === 'command') return '运行命令'
  if (entry.kind === 'file') return '处理文件'
  if (entry.kind === 'browser') return '操作网页'
  if (entry.kind === 'connector') return '调用连接器'
  if (entry.kind === 'subagent') return '执行协作任务'
  return '调用工具'
}

export function executionGroupStatus(entries: TaskTimelineEntry[]): string {
  const completed = entries.filter((entry) => entry.status === 'completed').length
  const failed = entries.filter((entry) => entry.status === 'failed').length
  const canceled = entries.filter((entry) => entry.status === 'canceled').length
  return [`共 ${entries.length} 次操作`, `完成 ${completed}`, failed ? `失败 ${failed}` : '', canceled ? `停止 ${canceled}` : '', entries.some((entry) => entry.status === 'running') ? '执行中' : ''].filter(Boolean).join(' · ')
}
