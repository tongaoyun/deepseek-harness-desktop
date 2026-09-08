import type { ExpertKitView, ExtensionDocument } from './expertKits'

export function expertKitSkillPrompt(kitId: string, skill: Pick<ExtensionDocument, 'id' | 'name'>): string {
  return `/kit:${kitId} 请使用套件中的「${skill.name}」（${skill.id}）技能。\n\n`
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
