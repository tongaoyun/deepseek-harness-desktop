export * from './DeepSeekHarnessCatalogSection.tsx'
export * from './DeepSeekHarnessCapabilitiesNavigation.tsx'
export * from './DeepSeekHarnessSettingsMenu.tsx'

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { en, NS, zh } from '../locales.ts'
import {
  ConnectorsPanel, ExpertKitsPanel, KnowledgePanel, SkillsPanel,
} from './DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, CapabilitiesHeading, createCapabilityChildIcon,
} from './DeepSeekHarnessCapabilitiesNavigation.tsx'
import { DeepSeekHarnessSettingsMenu } from './DeepSeekHarnessSettingsMenu.tsx'
import { createHarnessActions } from './harness-actions.ts'
import { TaskExpertKitSeat, TaskExpertKitHeader } from './TaskExpertKitSeat.tsx'
import { TaskKnowledgeInput } from './TaskKnowledgeInput.tsx'
import { registerKnowledgeToolResults } from './KnowledgeToolResult.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type {} from '@deepseek-ai/dsh-client-ui-skill/client'

export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'layout', 'uiSkills', 'remote', 'remote.agentPresets', 'commandUi',
]

const PANEL_COMPONENTS = {
  expertKits: ExpertKitsPanel,
  skills: SkillsPanel,
  connectors: ConnectorsPanel,
  knowledge: KnowledgePanel,
} as const

/** Register DeepSeekHarness capability navigation in the official Harness sidebar. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-harness-product: dictionaries')
  registerKnowledgeToolResults(ctx)
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    // The browser slot facade assigns the product's shadowing rank. Supplying
    // a fixed value here bypasses that rank and can leave the official account
    // launcher as the winner when the product package is reloaded.
    name: 'settings.launcher', locale: NS,
  }, DeepSeekHarnessSettingsMenu))
  const t = ctx.locale.bind(NS)
  const actions = createHarnessActions(ctx)
  const knowledgeOpeners = new Map<SessionId, () => void>()
  ctx.effect(() => () => { knowledgeOpeners.clear() }, 'product-knowledge: input openers')
  ctx.effect(() => ctx.commandUi.register({
    name: 'knowledge', label: () => t('referenceKnowledge'), icon: IconDatabaseOutlineRegular,
    available: session => knowledgeOpeners.has(session.sessionId) && ctx.sessions.subagentAddress(session.sessionId) === undefined,
    ui: { kind: 'action', run: (session) => { knowledgeOpeners.get(session.sessionId)?.() } },
  }), 'product-knowledge: Add menu')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'product-knowledge', order: 10, locale: NS,
    inject: sessionId => ({
      readMode: actions.readMode, readKnowledgeCatalog: actions.readKnowledgeCatalog,
      setKnowledgeSelection: actions.setKnowledgeSelection, recoverCapabilities: actions.recoverCapabilities,
      openCatalog: actions.openCatalog,
      subscribeOpen: (listener: () => void) => {
        knowledgeOpeners.set(sessionId, listener)
        return () => { if (knowledgeOpeners.get(sessionId) === listener) knowledgeOpeners.delete(sessionId) }
      },
    }),
  }, TaskKnowledgeInput))
  const kitInjected = () => ({
    readMode: actions.readMode,
    readExpertKits: actions.readExpertKits, setExpertKit: actions.setExpertKit,
    openCatalog: actions.openCatalog,
    recoverCapabilities: actions.recoverCapabilities,
  })
  ctx.slots.inject('conversation.hero.actions', () => ctx.slots.register({
    name: 'conversation.hero.actions', id: 'product-expert-kit', order: 10, locale: NS, inject: kitInjected,
  }, TaskExpertKitSeat))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'product-expert-kit', order: -5, locale: NS,
    inject: () => ({ readMode: actions.readMode, recoverCapabilities: actions.recoverCapabilities }),
  }, TaskExpertKitHeader))
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
