import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { splitComposerPrompt } from './composerInput'
import type { CapabilitySelection } from './types'

export interface ExtensionInvocation {
  token: string
  name: string
  description: string
  kind: 'expert-kit' | 'skill'
  id: string
  selection: CapabilitySelection
  /** A skill shipped by a kit. It remains a kit selection internally, while the composer exposes it
   *  alongside standalone skills so the employee can load only the method needed for this task. */
  bundledSkill?: boolean
}

export function extensionInvocations(kits: ExpertKitView[], skills: SkillView[]): ExtensionInvocation[] {
  return [
    ...skills.filter((skill) => skill.installed?.enabled !== false && skill.installState === 'installed').map((skill): ExtensionInvocation => ({
      token: `/skill:${skill.id}`, name: skill.name, description: skill.summary, kind: 'skill', id: skill.id,
      selection: { mode: 'explicit', kind: 'skill', extensionId: skill.id, extensionVersion: skill.installedVersion ?? skill.version, skillId: skill.id },
    })),
    ...kits.filter((kit) => kit.installed?.enabled !== false && kit.installState === 'installed').flatMap((kit): ExtensionInvocation[] => {
      const detailById = new Map((kit.skillDetails ?? []).map((skill) => [skill.id, skill]))
      const version = kit.installed?.manifest.version ?? kit.version
      const commands = kit.installed?.manifest.commands ?? []
      const skills = kit.installed?.manifest.skills ?? []
      return [
        { token: `/kit:${kit.id}`, name: kit.name, description: kit.summary, kind: 'expert-kit', id: kit.id,
          selection: { mode: 'explicit', kind: 'expert-kit', extensionId: kit.id, extensionVersion: version } },
        ...commands.map((command): ExtensionInvocation => ({
          token: `/kit:${kit.id}:${command.id}`, name: `${kit.name} · ${command.id}`, description: '执行套件快捷命令', kind: 'expert-kit', id: kit.id,
          selection: { mode: 'explicit', kind: 'expert-kit', extensionId: kit.id, extensionVersion: version, commandId: command.id, ...(command.skillId ? { skillId: command.skillId } : {}) },
        })),
        // A kit that ships no commands still exposes each bundled skill, so choosing one reads the
        // same as choosing a standalone skill instead of pasting a sentence into the draft.
        ...skills.map((skill): ExtensionInvocation => ({
          token: `/kit:${kit.id}:skill:${skill.id}`, name: detailById.get(skill.id)?.name || skill.id,
          description: `${kit.name} · ${detailById.get(skill.id)?.summary || '套件内技能'}`, kind: 'expert-kit', id: kit.id,
          selection: { mode: 'explicit', kind: 'expert-kit', extensionId: kit.id, extensionVersion: version, skillId: skill.id },
          bundledSkill: true,
        })),
      ]
    }),
  ]
}

export function sameCapabilitySelection(left: CapabilitySelection, right: CapabilitySelection): boolean {
  return left.mode === right.mode && left.kind === right.kind
    && left.extensionId === right.extensionId && left.extensionVersion === right.extensionVersion
    && left.skillId === right.skillId && left.commandId === right.commandId
}

export function selectedInvocations(prompt: string, options: ExtensionInvocation[]): ExtensionInvocation[] {
  return splitComposerPrompt(prompt).tokens.flatMap((token) => options.find((option) => option.token === token) ?? [])
}
