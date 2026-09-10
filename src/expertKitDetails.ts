import type { ExtensionDocument } from './expertKits'

export function expertKitSkillPrompt(kitId: string, skill: Pick<ExtensionDocument, 'id'>): string {
  return `/kit:${kitId}:skill:${skill.id} `
}

export function extensionCustomizationPrompt(name: string, directory: string, kind: 'expert-kit' | 'skill'): string {
  return `请帮我定制「${name}」。副本目录：${directory}\n先询问我要调整的岗位、工作流程或输出要求，再修改该目录中的文件。保留其他技能和辅助资源。完成后提醒我从${kind === 'skill' ? '技能' : '专家套件'}页面的“添加 → 上传”窗口选择本地文件夹，再点击“安装”。`
}
