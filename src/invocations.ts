import type { ExpertKitView } from './expertKits'

export interface InvocationOption {
  id: string
  kind: 'command'
  label: string
  description: string
  profileKind: 'expert-kit'
  profileId: string
  profileName: string
}

export function buildInvocationOptions(kits: ExpertKitView[]): InvocationOption[] {
  const installed = kits.filter((kit) => kit.installState === 'installed' || kit.installState === 'update')
  const options: InvocationOption[] = installed.flatMap((kit) => {
    const usingOlderVersion = kit.installState === 'update' && kit.installed
    const commandIds = usingOlderVersion ? kit.installed!.manifest.commands.map((command) => command.id) : kit.commandIds
    const profileName = usingOlderVersion ? kit.installed!.manifest.name : kit.name
    return commandIds.map((id): InvocationOption => ({
      id,
      kind: 'command',
      label: `/${id}`,
      description: `${profileName} · 快捷指令`,
      profileKind: 'expert-kit',
      profileId: kit.id,
      profileName,
    }))
  })
  return options.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
}

export function filterInvocationOptions(options: InvocationOption[], prompt: string): InvocationOption[] {
  if (!prompt.startsWith('/')) return []
  const rawQuery = prompt.slice(1)
  if (/\s/.test(rawQuery)) return []
  const query = rawQuery.toLowerCase()
  return options.filter((option) => !query
    || option.id.toLowerCase().includes(query)
    || option.profileName.toLowerCase().includes(query)).slice(0, 8)
}
