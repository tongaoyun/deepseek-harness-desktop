import type { ExtensionDocument } from './expertKits'

export function expertKitSkillPrompt(kitId: string, skill: Pick<ExtensionDocument, 'id' | 'name'>): string {
  return `/kit:${kitId} 请使用套件中的「${skill.name}」（${skill.id}）技能。\n\n`
}

export function extensionCustomizationPrompt(name: string, directory: string, kind: 'expert-kit' | 'skill', document?: Pick<ExtensionDocument, 'id' | 'name' | 'path'>): string {
  const target = document ? `「${name}」中的「${document.name}」` : `「${name}」`
  const scope = document ? `本次定制目标文件：${JSON.stringify(document.path)}，执行 ID：${JSON.stringify(document.id)}。先询问我要如何调整该技能或命令，再修改目标文件及必要的关联资源。` : '先询问我要调整的岗位、工作流程或输出要求，再修改该目录中的文件。'
  return `请帮我定制${target}。副本目录：${directory}\n${scope}保留其他技能和辅助资源。完成后提醒我从${kind === 'skill' ? '技能' : '专家套件'}页面的“添加 → 上传”窗口选择本地文件夹，再点击“安装”。`
}
