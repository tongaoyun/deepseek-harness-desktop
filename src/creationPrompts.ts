export type XiaoyinCreationKind = 'schedule' | 'skill' | 'expert-kit'

const PROMPTS: Record<XiaoyinCreationKind, string> = {
  schedule: '我要创建一个定时任务，每【时间间隔】执行【具体任务】',
  skill: '我要创建一个技能，帮助我完成【具体任务】，期望输出【结果】',
  'expert-kit': '我要创建一个专家套件，面向【岗位或团队】，完成【工作场景】。请整理工作方法、执行步骤、输出标准、需要的技能和连接器，并生成可保存的方案。',
}

export function creationPrompt(kind: XiaoyinCreationKind): string {
  return PROMPTS[kind]
}
