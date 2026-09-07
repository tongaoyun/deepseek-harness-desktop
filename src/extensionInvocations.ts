import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'

export interface ExtensionInvocation {
  token: string
  name: string
  description: string
  kind: 'expert-kit' | 'skill'
  id: string
}

export function extensionInvocations(kits: ExpertKitView[], skills: SkillView[]): ExtensionInvocation[] {
  return [
    ...skills.filter((skill) => skill.installed?.enabled !== false && ['installed', 'update'].includes(skill.installState)).map((skill): ExtensionInvocation => ({
      token: `/skill:${skill.id}`, name: skill.name, description: skill.summary, kind: 'skill', id: skill.id,
    })),
    ...kits.filter((kit) => kit.installed?.enabled !== false && ['installed', 'update'].includes(kit.installState)).flatMap((kit): ExtensionInvocation[] => [
      { token: `/kit:${kit.id}`, name: kit.name, description: kit.summary, kind: 'expert-kit', id: kit.id },
      ...(kit.installed?.manifest.commands.map((command) => command.id) ?? kit.commandIds).map((id): ExtensionInvocation => ({
        token: `/kit:${kit.id}:${id}`, name: `${kit.name} · ${id}`, description: '执行套件快捷命令', kind: 'expert-kit', id: kit.id,
      })),
    ]),
  ]
}

export function selectedInvocation(prompt: string, options: ExtensionInvocation[]): ExtensionInvocation | undefined {
  const token = prompt.trim().split(/\s/u)[0]
  return options.find((option) => option.token === token)
}
