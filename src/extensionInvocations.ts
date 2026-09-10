import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { splitComposerPrompt } from './composerInput'

export interface ExtensionInvocation {
  token: string
  name: string
  description: string
  kind: 'expert-kit' | 'skill'
  id: string
}

export function extensionInvocations(kits: ExpertKitView[], skills: SkillView[]): ExtensionInvocation[] {
  return [
    ...skills.filter((skill) => skill.installed?.enabled !== false && skill.installState === 'installed').map((skill): ExtensionInvocation => ({
      token: `/skill:${skill.id}`, name: skill.name, description: skill.summary, kind: 'skill', id: skill.id,
    })),
    ...kits.filter((kit) => kit.installed?.enabled !== false && kit.installState === 'installed').flatMap((kit): ExtensionInvocation[] => [
      { token: `/kit:${kit.id}`, name: kit.name, description: kit.summary, kind: 'expert-kit', id: kit.id },
      ...(kit.installed?.manifest.commands.map((command) => command.id) ?? kit.commandIds).map((id): ExtensionInvocation => ({
        token: `/kit:${kit.id}:${id}`, name: `${kit.name} · ${id}`, description: '执行套件快捷命令', kind: 'expert-kit', id: kit.id,
      })),
    ]),
  ]
}

export function selectedInvocations(prompt: string, options: ExtensionInvocation[]): ExtensionInvocation[] {
  return splitComposerPrompt(prompt).tokens.flatMap((token) => options.find((option) => option.token === token) ?? [])
}
