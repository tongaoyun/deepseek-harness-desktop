import type { ExpertKitView, ExtensionDocument } from './expertKits'

export function expertKitSkillPrompt(kitId: string, skill: Pick<ExtensionDocument, 'id' | 'name'>): string {
  return `/kit:${kitId} 请使用套件中的「${skill.name}」（${skill.id}）技能。\n\n`
}

export function extensionCustomizationPrompt(name: string, directory: string, kind: 'expert-kit' | 'skill', document?: Pick<ExtensionDocument, 'id' | 'name' | 'path'>): string {
  const target = document ? `「${name}」中的「${document.name}」` : `「${name}」`
  const scope = document ? `本次定制目标文件：${JSON.stringify(document.path)}，执行 ID：${JSON.stringify(document.id)}。先询问我要如何调整该技能或命令，再修改目标文件及必要的关联资源。` : '先询问我要调整的岗位、工作流程或输出要求，再修改该目录中的文件。'
  return `请帮我定制${target}。副本目录：${directory}\n${scope}保留其他技能和辅助资源。完成后提醒我从${kind === 'skill' ? '技能' : '专家套件'}页面的“添加 → 上传”窗口选择本地文件夹，再点击“安装”。`
}

export function expertKitChanges(kit: ExpertKitView): string[] {
  if (kit.installState !== 'update' || !kit.installed) return []
  const installed = kit.installed.manifest
  const changes = [
    ...setChanges('命令', installed.commands.map((entry) => entry.id), kit.commandIds),
    ...setChanges('技能', installed.skills.map((entry) => entry.id), kit.skillIds),
    ...setChanges('连接器', installed.connectorRefs, kit.connectorRefs),
    ...setChanges('知识库', installed.knowledgeBaseRefs ?? [], kit.knowledgeBaseRefs),
    ...setChanges('后台工作流', installed.serverWorkflows.map((entry) => entry.id), kit.serverWorkflows.map((entry) => entry.id)),
  ]
  return changes.length > 0 ? changes : ['能力声明没有变化，本次仅更新套件内容。']
}

function setChanges(label: string, before: string[], after: string[]): string[] {
  const previous = new Set(before)
  const next = new Set(after)
  const added = after.filter((value) => !previous.has(value))
  const removed = before.filter((value) => !next.has(value))
  return [
    ...(added.length > 0 ? [`新增${label}：${added.join('、')}`] : []),
    ...(removed.length > 0 ? [`移除${label}：${removed.join('、')}`] : []),
  ]
}
