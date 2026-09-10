import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { splitComposerPrompt } from './composerInput'

export interface ExtensionInvocation {
  token: string
  name: string
  description: string
  kind: 'expert-kit' | 'skill'
  id: string
  /** A skill reachable only through its kit: usable and shown as a skill, but not a capability the
   *  employee picks from the top-level menus, where its kit already stands for it. */
  bundledSkill?: boolean
}

export function extensionInvocations(kits: ExpertKitView[], skills: SkillView[]): ExtensionInvocation[] {
  return [
    ...skills.filter((skill) => skill.installed?.enabled !== false && skill.installState === 'installed').map((skill): ExtensionInvocation => ({
      token: `/skill:${skill.id}`, name: skill.name, description: skill.summary, kind: 'skill', id: skill.id,
    })),
    ...kits.filter((kit) => kit.installed?.enabled !== false && kit.installState === 'installed').flatMap((kit): ExtensionInvocation[] => {
      const detailById = new Map((kit.skillDetails ?? []).map((skill) => [skill.id, skill]))
      return [
        { token: `/kit:${kit.id}`, name: kit.name, description: kit.summary, kind: 'expert-kit', id: kit.id },
        ...(kit.installed?.manifest.commands.map((command) => command.id) ?? kit.commandIds).map((id): ExtensionInvocation => ({
          token: `/kit:${kit.id}:${id}`, name: `${kit.name} · ${id}`, description: '执行套件快捷命令', kind: 'expert-kit', id: kit.id,
        })),
        // A kit that ships no commands still exposes each bundled skill, so choosing one reads the
        // same as choosing a standalone skill instead of pasting a sentence into the draft.
        ...(kit.installed?.manifest.skills.map((skill) => skill.id) ?? kit.skillIds).map((id): ExtensionInvocation => ({
          token: `/kit:${kit.id}:skill:${id}`, name: detailById.get(id)?.name || id,
          description: detailById.get(id)?.summary || `${kit.name}中的工作方法`, kind: 'expert-kit', id: kit.id,
          bundledSkill: true,
        })),
      ]
    }),
  ]
}

export function selectedInvocations(prompt: string, options: ExtensionInvocation[]): ExtensionInvocation[] {
  return splitComposerPrompt(prompt).tokens.flatMap((token) => options.find((option) => option.token === token) ?? [])
}
