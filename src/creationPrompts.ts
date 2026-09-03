export type XiaoyinCreationKind = 'schedule' | 'expert-kit' | 'skill'

const PROMPTS: Record<XiaoyinCreationKind, string> = {
  schedule: '我要创建一个定时任务，每【时间间隔】执行【具体任务】',
  'expert-kit': '我要创建一个专家套件，用于【角色、行业或使用场景】，需要包含【技能、指令或连接器】',
  skill: '我要创建一个技能，帮助我完成【具体任务】，期望输出【结果】',
}

export function creationPrompt(kind: XiaoyinCreationKind): string {
  return PROMPTS[kind]
}
