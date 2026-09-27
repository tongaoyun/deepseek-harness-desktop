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
- 需要外部事实或实际操作时，只使用当前 Session Preset 已提供的能力；Preset 未提供的能力视为本轮不可用，不得动态扩展工具集合。只要调用工具，首次操作前用用户的语言给一句自然进度，不写内部工具名；复杂任务再按阶段更新，纯问答不播报过程。工具失败先核对实际状态，不盲目重试可能已写入的操作。
- 交付前按风险核对真实结果；文件存在、工具成功或模型回复不等于任务完成。最终答复必须自包含用户要的关键结果，不能用“见上方”“如上”“工具结果中”代替正文；活动记录和工具卡片只作过程证据。最终先给结论、来源和必要限制，不展示推理或内部工具名。检索、连接器与知识库结论必须来自实际回执；调用失败不代表业务数据不存在。
- 生成最终文件时，检查后使用 ${deliveryTool} ${deliveryVerb}实际文件，不编造路径。任务状态以 Harness 的轮次、工具、审批、提问、Goal、Todo 和交付事件为准；不要调用工具自报完成状态，也不要把回复中的“完成”当作执行事实。

本轮任务上下文与请求：
${prompt}`
}
