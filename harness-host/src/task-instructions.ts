/** Shared by desktop and online desktop-hosted IM turns. */
export interface TaskInstructionOptions {
  useOfficialPresent?: boolean
}

const TASK_CONTEXT_SEPARATOR = '\n\n本轮任务上下文与请求：\n'
const MEMORY_PREFIX = '<xiaoyin-memory>\n'
const MEMORY_SUFFIX = '\n</xiaoyin-memory>\n\n当前任务：\n'
const DESKTOP_TASK_SEPARATOR = '\n\n员工任务：\n'
const REPLAY_TASK_SEPARATOR = '\n\n当前任务：\n\n'

/** Recover the employee's text from the product-owned wrapper in persisted user messages. */
export function visibleTaskPrompt(value: string): string {
  if (!value.startsWith('小胤任务执行约定：\n- 先判断本轮意图')
    && !value.startsWith('小胤任务执行约定：\n- 先判断意图')) return value
  const separator = value.indexOf(TASK_CONTEXT_SEPARATOR)
  if (separator < 0) return ''
  let context = value.slice(separator + TASK_CONTEXT_SEPARATOR.length)
  if (context.startsWith(MEMORY_PREFIX)) {
    const memoryEnd = context.indexOf(MEMORY_SUFFIX)
    if (memoryEnd < 0) return ''
    context = context.slice(memoryEnd + MEMORY_SUFFIX.length)
  }
  if (context.startsWith('你正在小胤桌面端')) {
    const taskStart = context.indexOf(DESKTOP_TASK_SEPARATOR)
    if (taskStart < 0) return ''
    context = context.slice(taskStart + DESKTOP_TASK_SEPARATOR.length)
  }
  if (context.startsWith('以下是同一任务在重建本地执行会话前的可见对话')) {
    const taskStart = context.lastIndexOf(REPLAY_TASK_SEPARATOR)
    return taskStart < 0 ? '' : context.slice(taskStart + REPLAY_TASK_SEPARATOR.length)
  }
  return context
}

export function withTaskInstructions(prompt: string, options: TaskInstructionOptions = {}): string {
  const deliveryTool = options.useOfficialPresent ? 'present' : 'local_files_publish'
  const deliveryVerb = options.useOfficialPresent ? '声明' : '登记'
  return `小胤任务执行约定：
- 先判断意图：纯问答或闲聊直接简短回答，不调用工具，也不附加无关追问；具体目标才规划、执行和核验。只在缺少会阻止继续的关键信息时提问，不用关键词、消息长度、工作目录或能力选择替代意图判断。
- 询问、检查和诊断不代表授权修改；明确要求实施才动手。遵守现有权限、审批与只读范围，不凭名称猜测能力，不编造事实、工具结果、企业数据或成果。已获授权的任务持续推进，不重复索要授权；停止请求后不再行动。
- 需要外部事实或实际操作时，用 tool_discover 选择所需类别，可一次选多个；解锁不授予新权限。复杂任务用用户的语言简述阶段进度，简单问答不播报过程。工具失败先核对实际状态，不盲目重试可能已写入的操作。
- 交付前按风险核对真实结果；文件存在、工具成功或模型回复不等于任务完成。最终先给结论、来源和必要限制，不展示推理或内部工具名。检索、连接器与知识库结论必须来自实际回执；调用失败不代表业务数据不存在。
- 生成最终文件时，检查后使用 ${deliveryTool} ${deliveryVerb}实际文件，不编造路径。执行任务结束前以 task_report 为最后一个工具调用，必须填写 status、summary、remaining 和 checks；completed 仅用于目标及必需检查都通过且 remaining 为空，否则报告真实阻碍。报告后又调用工具须重新报告。纯问答无需报告，也不等于执行目标已验收。

本轮任务上下文与请求：
${prompt}`
}

/** Detailed operating rules are sent only after the agent selects a tool family. */
export function discoveryGuidance(groups: readonly string[], publishingTool: 'present' | 'local_files_publish'): string {
  const guidance: Record<string, string> = {
    files: `先确认授权路径和当前文件状态，追加修改沿用已有成果。读写后重新读取实际内容核对，不把文件存在当作内容正确。最终文件和图片检查后用 ${publishingTool} 声明；多文件逐个交付，不登记临时文件、缓存或整个项目。用户要可编辑原文件时不能只交截图或文字。`,
    office: `文档或表格的事实与建议必须对应实际读取的内容及位置；未读取的范围不能声称为空，字段未见不能反推业务只有一个仓库或期间。简单表格优先 office_xlsx_*；公式用 {"formula":"C2*D2"}，普通字符串不会自动成为公式。写入公式后检查缓存和重算，不能伪造计算结果。用 office_document_check 查结构；PDF 扫描件或版面用 office_pdf_page 按页核对，渲染一页不代表检查整份文件。表格导出前可用 office_xlsx_format_sheet 设置宽度、换行、行高和打印范围，改动后检查页面。版面转换或公式重算前先用 office_engine_status 检查依赖；office_document_export_pdf 和 office_xlsx_recalculate 输出新副本，不能覆盖源文件，需核对 verification。缺少引擎时说明限制；重算后同步更新人工说明。Office 工具已声明的文件无需重复声明，除非后续又修改。`,
    knowledge: '仅在实际检索命中后引用知识库内容；核对文档来源和摘录，不把未读取范围当作不存在。',
    connectors: '企业实时数据仅以成功的连接器工具回执为准；核对参数、店铺或业务范围。工具报错只能说明本次查询失败，不推断数据不存在。写入操作按原有审批执行，不能因发现工具而越权。',
    skills: '需要岗位方法时匹配并实际加载已安装技能，阅读技能原文与依赖；不可凭技能名称猜测内容，也不可宣称未加载的技能已执行。',
    web: '引用实际访问的页面和来源，无法访问或内容不完整时明确限制，不用模型记忆冒充实时检索。',
    code: '代码改动后运行相关测试或构建并核对结果；Shell 失败先检查现状，不重复可能已完成的写入。生成最终成果先检查，需发布时再发现 files 类别并使用文件声明工具。',
    desktop: '操作本机应用前观察目标窗口，只依据当前控件和坐标操作；窗口变化后重新观察。操作报错可能已有输入或写入，先核查实际状态；保存后通过应用重新打开或读取核对，不把点击成功当保存成功。',
    workflow: '复杂任务按依赖拆成可验证步骤；子 Agent 只做独立工作，主 Agent 负责整合与验收，不让多个 Agent 同时修改同一文件或外部资源。',
    other: '仅使用当前运行时真实提供的工具；未知操作按原有权限和审批处理，核对回执后再交付。',
  }
  return [
    '小胤执行细则（工具发现后适用）：',
    ...groups.flatMap((group) => guidance[group] ? [`- ${guidance[group]}`] : []),
    '- 仅列目标必需且实际执行的 checks；completed 中每项须 passed，remaining 必须为空。关键目标未核验用 unverified；缺资料、待确认、部分完成或受阻分别用对应状态，并列出下一步。可选信息未核实写在答复限制中，不加 not_run 检查。task_report 只记录判断，不执行核验也不授予权限。',
  ].join('\n')
}
