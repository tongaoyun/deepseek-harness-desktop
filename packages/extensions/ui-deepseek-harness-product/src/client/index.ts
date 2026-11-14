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
import type { DesktopUpdateBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../locales.ts'
import {
  ConnectorsPanel,
} from './DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, EXTENSION_PANELS, CapabilitiesHeading, createCapabilityChildIcon,
} from './DeepSeekHarnessCapabilitiesNavigation.tsx'
import * as Experts from '@deepseek-harness/product-experts/client'
import * as Skills from '@deepseek-harness/product-skills/client'
import { DeepSeekHarnessSettingsMenu } from './DeepSeekHarnessSettingsMenu.tsx'
import { createHarnessActions } from './harness-actions.ts'
import { TaskLibraryInput } from './TaskLibraryInput.tsx'
import { LibraryArchive } from './LibraryArchive.tsx'
import { LibraryPanel } from './LibraryPanel.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { createEmployeeSignInActions } from './employee-sign-in.ts'

export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'layout', 'remote', 'remote.agentPresets', 'commandUi',
]

const PANEL_COMPONENTS = {
  connectors: ConnectorsPanel,
  library: LibraryPanel,
} as const

/** Register DeepSeekHarness capability navigation in the official Harness sidebar. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'deepseek-harness-product: dictionaries')
  ctx.plugin(Experts)
  ctx.plugin(Skills)
  const carrier = (globalThis as { dshDesktop?: { protocolVersion?: number; updates?: Pick<DesktopUpdateBridge, 'open'> } }).dshDesktop
  const updates = carrier?.protocolVersion === 1 ? carrier.updates : undefined
  const employeeSignIn = createEmployeeSignInActions(ctx)
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    // The browser slot facade assigns the product's shadowing rank. Supplying
    // a fixed value here bypasses that rank and can leave the official account
    // launcher as the winner when the product package is reloaded.
    name: 'settings.launcher', locale: NS,
    inject: () => ({ ...employeeSignIn, ...updates === undefined ? {} : { openSoftwareUpdate: () => updates.open() } }),
  }, DeepSeekHarnessSettingsMenu))
  const t = ctx.locale.bind(NS)
  const actions = createHarnessActions(ctx)
  const libraryOpeners = new Map<SessionId, () => void>()
  ctx.effect(() => () => { libraryOpeners.clear() }, 'product-library: input openers')
  ctx.effect(() => ctx.commandUi.register({
    name: 'library', label: () => t('libraryChooseFiles'), icon: IconDatabaseOutlineRegular,
    available: session => libraryOpeners.has(session.sessionId) && ctx.sessions.subagentAddress(session.sessionId) === undefined,
    ui: { kind: 'action', run: (session) => { libraryOpeners.get(session.sessionId)?.() } },
  }), 'product-library: Add menu')
  ctx.slots.inject('conversation.input.references', () => ctx.slots.register({
    name: 'conversation.input.references', id: 'product-library', order: 10, locale: NS,
    inject: sessionId => ({
      attachLibraryFiles: (id, entries, signal) => actions.attachLibraryFiles(id, entries, signal),
      openEmployeeSignIn: employeeSignIn.openEmployeeSignIn,
      focusInput: () => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding) ctx.conversation.input.for(binding.ctx).focus()
      },
      subscribeOpen: (listener: () => void) => {
        libraryOpeners.set(sessionId, listener)
        return () => { if (libraryOpeners.get(sessionId) === listener) libraryOpeners.delete(sessionId) }
      },
    }),
  }, TaskLibraryInput))
  ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register({
    name: 'deliverables.file.actions', id: 'product-library-archive', order: 10, locale: NS,
  }, LibraryArchive))
  ctx.slots.inject('sidebar.panelheading', () => ctx.slots.register({
    name: 'sidebar.panelheading', id: 'deepseek-harness-capabilities', order: -40, locale: NS,
  }, CapabilitiesHeading))

  for (const [index, panel] of EXTENSION_PANELS.entries()) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panel.id, order: -39 + index, locale: NS,
      label: () => t(panel.labelKey),
    }, createCapabilityChildIcon(panel.icon)))
  }

  for (const [index, panel] of CAPABILITY_PANELS.entries()) {
    const Component = PANEL_COMPONENTS[panel.labelKey]
    const ChildIcon = createCapabilityChildIcon(panel.icon)
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: panel.id, locale: NS, inject: () => ({ openEmployeeSignIn: employeeSignIn.openEmployeeSignIn,
        ...(panel.labelKey === 'library' ? {
          startLibraryCreation: (kind: 'document' | 'presentation' | 'spreadsheet' | 'html') => {
            const prompt = { document: 'libraryPromptDocument', presentation: 'libraryPromptPresentation', spreadsheet: 'libraryPromptSpreadsheet', html: 'libraryPromptHtml' } as const
            ctx.uiWorkspace.startSession(undefined, { prompt: t(prompt[kind]), whenDraftExists: 'append' })
          },
          openLibrarySource: (sessionId: string) => { ctx.uiWorkspace.openSession(sessionId as SessionId) },
        } : {}),
      }),
    }, Component))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panel.id, order: -37 + index, locale: NS,
      label: () => t(panel.labelKey),
    }, ChildIcon))
  }
}
