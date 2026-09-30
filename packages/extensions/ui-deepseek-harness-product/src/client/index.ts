export * from './DeepSeekHarnessCatalogSection.tsx'
export * from './DeepSeekHarnessCapabilitiesNavigation.tsx'
export * from './DeepSeekHarnessSettingsMenu.tsx'

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { en, NS, zh } from '../locales.ts'
import {
  ConnectorsPanel, ExpertKitsPanel, KnowledgePanel, SkillsPanel,
} from './DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, CapabilitiesHeading, createCapabilityChildIcon,
} from './DeepSeekHarnessCapabilitiesNavigation.tsx'
import { DeepSeekHarnessSettingsMenu } from './DeepSeekHarnessSettingsMenu.tsx'

export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'conversation']

const PANEL_COMPONENTS = {
  expertKits: ExpertKitsPanel,
  skills: SkillsPanel,
  connectors: ConnectorsPanel,
  knowledge: KnowledgePanel,
} as const

/** Register DeepSeekHarness capability navigation in the official Harness sidebar. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-harness-product: dictionaries')
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', priority: -100, locale: NS,
  }, DeepSeekHarnessSettingsMenu))
  const t = ctx.locale.bind(NS)
  const mainSessionId = (): SessionId | undefined => Object.values(ctx.sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const workspaceForSession = (sessionId: SessionId) => ctx.workspaces.list.getSnapshot().items
    .find(workspace => workspace.sessionIds.includes(sessionId))
  const ensureWorkspace = async () => {
    const current = mainSessionId()
    const currentWorkspace = current === undefined ? undefined : workspaceForSession(current)
    if (currentWorkspace !== undefined) return currentWorkspace
    const existing = ctx.workspaces.list.getSnapshot().items[0]
    if (existing !== undefined) return existing
    const initialized = await ctx.workspaces.initializeDefault()
    if (initialized === undefined) throw new Error('deepseek-harness product: no Workspace is available')
    return initialized
  }
  const openDraft = (sessionId: SessionId, draft: string): void => {
    ctx.uiWorkspace.openSession(sessionId)
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`deepseek-harness product: session ${sessionId} did not open`)
    const input = ctx.conversation.input.for(binding.ctx)
    const current = input.state.getSnapshot().draft.trimEnd()
    input.setDraft(current === '' ? draft : `${current}\n${draft}`)
    input.focus()
  }
  const actions = {
    async setExpertKitEnabled(id: string, enabled: boolean): Promise<void> {
      const api = (globalThis as { deepseekHarness?: { product?: { invoke(method: string, payload?: unknown): Promise<unknown> } } })
        .deepseekHarness?.product
      if (api === undefined) throw new Error('deepseek-harness product: product bridge is unavailable')
      await api.invoke('expertKits.enablement.set', { id, enabled })
    },
    async useExpertKitCommand(skillId: string, description: string): Promise<void> {
      const workspace = await ensureWorkspace()
      const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
      openDraft(sessionId, `/${skillId} ${description}`)
    },
    async useSkill(skillId: string): Promise<void> {
      const current = mainSessionId()
      const sessionId = current ?? await ctx.sessions.create({
        workspaceId: (await ensureWorkspace()).workspaceId,
      })
      openDraft(sessionId, `/${skillId} `)
    },
  }
  ctx.slots.inject('sidebar.panelheading', () => ctx.slots.register({
    name: 'sidebar.panelheading', id: 'deepseek-harness-capabilities', order: -40, locale: NS,
  }, CapabilitiesHeading))

  for (const [index, panel] of CAPABILITY_PANELS.entries()) {
    const Component = PANEL_COMPONENTS[panel.labelKey]
    const ChildIcon = createCapabilityChildIcon(panel.icon)
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: panel.id, locale: NS, inject: () => actions,
    }, Component))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panel.id, order: -39 + index, locale: NS,
      label: () => t(panel.labelKey),
    }, ChildIcon))
  }
}
