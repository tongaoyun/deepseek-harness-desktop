import * as cordis from '@deepseek-ai/cordis'
import * as clientStore from '@deepseek-ai/dsh-client-store'
import type { ClientBundleRegistration, ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import * as react from 'react'
import * as reactDom from 'react-dom'
import * as reactDomClient from 'react-dom/client'
import * as reactJsxRuntime from 'react/jsx-runtime'

type ModuleFactory = ClientBundleRegistration['factory']
type ClientRequire = ((specifier: string) => unknown) & { async: (specifier: string) => Promise<unknown> }

interface ModuleLoaderFacade extends ClientModuleLoaderTarget {
  load(registration: ClientBundleRegistration): void
}

export interface OfficialConversationModules {
  conversation: Record<string, unknown>
  chat: Record<string, unknown>
  session: Record<string, unknown>
  renderer: Record<string, unknown>
  layout: Record<string, unknown>
  tool: Record<string, unknown>
  approval: Record<string, unknown>
  questions: Record<string, unknown>
  trajectory: Record<string, unknown>
}

const factories = new Map<string, ModuleFactory>()
const registrations = new Map<string, ClientBundleRegistration>()
const modules = new Map<string, Record<string, unknown>>()
let installed = false
let created = false
let createModuleSystem: typeof import('@deepseek-ai/dsh-client-modules/client').createClientModuleSystem | undefined
let staticModules: Record<string, unknown> | undefined

/**
 * Load an official Harness browser bundle in the Vite/Tauri shell.
 *
 * Harness browser packages are intentionally emitted as Cordis ModuleLoader
 * carriers, not ordinary ESM. The official web shell installs this facade
 * before loading them; Xiaoyin must do the same when it embeds the official
 * Conversation source instead of importing a second renderer implementation.
 */
export async function importOfficialClient(id: string): Promise<Record<string, unknown>> {
  installModuleLoader()
  modules.set('@deepseek-ai/cordis', cordis as unknown as Record<string, unknown>)
  modules.set('@deepseek-ai/dsh-client-store', clientStore as unknown as Record<string, unknown>)
  // These packages import browser CSS and syntax-highlighting assets. Keep
  // them behind the UI runtime's lazy boundary so the event adapter does not
  // make Node/Vitest execute browser-only stylesheets.
  if (id.includes('/dsh-client-ui-')) {
    const [uiPrimitives, uiSlots] = await Promise.all([
      import('@deepseek-ai/dsh-client-ui-primitives'),
      import('@deepseek-ai/dsh-client-ui-slots'),
    ])
    modules.set('@deepseek-ai/dsh-client-ui-primitives', uiPrimitives as unknown as Record<string, unknown>)
    modules.set('@deepseek-ai/dsh-client-ui-primitives/client', uiPrimitives as unknown as Record<string, unknown>)
    modules.set('@deepseek-ai/dsh-client-ui-slots', uiSlots as unknown as Record<string, unknown>)
    modules.set('@deepseek-ai/dsh-client-ui-slots/client', uiSlots as unknown as Record<string, unknown>)
  }
  modules.set('react', react as unknown as Record<string, unknown>)
  modules.set('react-dom', reactDom as unknown as Record<string, unknown>)
  modules.set('react/jsx-runtime', reactJsxRuntime as unknown as Record<string, unknown>)
  // The published UI carriers resolve these shared browser bundles through
  // ModuleLoader rather than ESM imports. Register every official UI
  // dependency once so loading the Conversation/Chat renderer cannot silently
  // fall back to a second local implementation.
  await importOfficialBundle('@deepseek-ai/dsh-api-gateway/client')
  if (id.includes('/dsh-client-ui-')) await importOfficialBundle('@deepseek-ai/dsh-api-session-controller/client')
  await importOfficialBundle(id)
  return requireOfficial(id)
}

/**
 * Load the complete official browser Conversation roster as one unit. The
 * Harness UI packages are carrier modules; loading only one of them leaves
 * the Slot registry incomplete and produces a blank shell. Keeping this
 * roster in one function also gives the desktop bridge one explicit boot
 * boundary instead of a second, product-owned renderer registry.
 */
export async function loadOfficialConversationUi(): Promise<OfficialConversationModules> {
  const [conversation, chat, session, renderer, layout, tool, approval, questions, trajectory] = await Promise.all([
    importOfficialClient('@deepseek-ai/dsh-client-ui-conversation/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-chat/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-session/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-renderer/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-layout/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-tool/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-approval/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-user-questions/client'),
    importOfficialClient('@deepseek-ai/dsh-client-ui-trajectory/client'),
  ])
  return { conversation, chat, session, renderer, layout, tool, approval, questions, trajectory }
}

/**
 * Load the complete official browser application roster. This is deliberately
 * separate from the product shell: the official AppWebEntry consumes the same
 * module graph and Slot renderer as the upstream browser, while the Tauri
 * bridge supplies only the Connection transport.
 */
export async function loadOfficialClientRoster(): Promise<void> {
  installModuleLoader()
  const web = await import('@deepseek-ai/dsh-client-web')
  await importOfficialBundle('@deepseek-ai/dsh-client-modules/client')
  const moduleApi = requireOfficial('@deepseek-ai/dsh-client-modules/client') as unknown as {
    createClientModuleSystem?: typeof createModuleSystem
  }
  createModuleSystem = moduleApi.createClientModuleSystem
  const getStaticModules = web.getStaticModules
    ?? (web as unknown as { default?: { getStaticModules?: typeof web.getStaticModules } }).default?.getStaticModules
  staticModules = typeof getStaticModules === 'function' ? getStaticModules() : {
    react,
    'react-dom': reactDom,
    'react-dom/client': reactDomClient,
    'react/jsx-runtime': reactJsxRuntime,
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-store': clientStore,
  }
  for (const [id, value] of Object.entries(staticModules)) {
    modules.set(id, value as unknown as Record<string, unknown>)
  }
  // These are official platform externals, not product replacements. Keep
  // the same instances available to the eager carrier materializer as the
  // official web shell's static module table.
  const [uiPrimitives, uiSlots, uiDockkit] = await Promise.all([
    import('@deepseek-ai/dsh-client-ui-primitives'),
    import('@deepseek-ai/dsh-client-ui-slots'),
    import('@deepseek-ai/dsh-client-ui-dockkit'),
  ])
  staticModules = {
    ...staticModules,
    '@deepseek-ai/dsh-client-ui-primitives': uiPrimitives,
    '@deepseek-ai/dsh-client-ui-slots': uiSlots,
    '@deepseek-ai/dsh-client-ui-dockkit': uiDockkit,
  }
  modules.set('@deepseek-ai/dsh-client-ui-primitives', uiPrimitives as unknown as Record<string, unknown>)
  modules.set('@deepseek-ai/dsh-client-ui-slots', uiSlots as unknown as Record<string, unknown>)
  const ids = [
    '@deepseek-ai/dsh-client-modules/client',
    '@deepseek-ai/dsh-client-connection/client',
    '@deepseek-ai/dsh-typert-registry/client',
    '@deepseek-ai/dsh-api-gateway/client',
    '@deepseek-ai/dsh-api-remotes/client',
    '@deepseek-ai/dsh-client-file-upload/client',
    '@deepseek-ai/dsh-client-locale/client',
    '@deepseek-ai/dsh-client-ui-settings/client',
    '@deepseek-ai/dsh-client-ui-renderer/client',
    '@deepseek-ai/dsh-client-resources/client',
    '@deepseek-ai/dsh-client-ui-theme/client',
    '@deepseek-ai/dsh-client-shortcuts/client',
    '@deepseek-ai/dsh-api-workspace-controller/client',
    '@deepseek-ai/dsh-api-session-controller/client',
    '@deepseek-ai/dsh-client-ui-session/client',
    '@deepseek-ai/dsh-client-ui-layout/client',
    '@deepseek-ai/dsh-client-ui-sidebar/client',
    '@deepseek-ai/dsh-client-ui-sidebar-right/client',
    '@deepseek-ai/dsh-client-ui-sidebar-browser/client',
    '@deepseek-ai/dsh-client-ui-workspace/client',
    '@deepseek-ai/dsh-client-ui-conversation/client',
    '@deepseek-ai/dsh-client-ui-input-trigger/client',
    '@deepseek-ai/dsh-client-ui-chat/client',
    '@deepseek-ai/dsh-client-ui-tool/client',
    '@deepseek-ai/dsh-client-ui-approval/client',
    '@deepseek-ai/dsh-client-ui-user-questions/client',
    '@deepseek-ai/dsh-client-ui-trajectory/client',
  ]
  for (const id of ids) await importOfficialClient(id)
}

/** Prepare the cached official carriers for a fresh AppWebEntry mount. */
export function releaseOfficialClientRuntime(): void {
  installed = false
  created = false
}

/** Create the official upstream module system from the queued carrier bundles. */
export function createOfficialClientModuleSystem(boot: unknown): unknown {
  installModuleLoader()
  if (created) throw new Error('官方 Harness Client 只能创建一次')
  const target = (globalThis as { __ModuleLoader__?: ModuleLoaderFacade }).__ModuleLoader__
  if (target === undefined) throw new Error('官方 Harness ModuleLoader 未安装')
  const bootstrapId = '@deepseek-ai/dsh-client-modules'
  const bootstrap = requireOfficial(`${bootstrapId}/client`)
  if (!createModuleSystem || !staticModules) throw new Error('官方 Harness Client 尚未预加载')
  const system = createModuleSystem(target, { id: bootstrapId, exports: bootstrap }, {
    boot,
    staticModules,
    loadBundle: async () => {
      throw new Error('官方 Harness 桌面端不允许从网络加载浏览器包')
    },
  })
  created = true
  return system
}

function installModuleLoader(): void {
  if (installed) return
  const host = globalThis as { __ModuleLoader__?: ModuleLoaderFacade; window?: { __ModuleLoader__?: ModuleLoaderFacade } }
  const target = host.window ?? host
  if (host.__ModuleLoader__ !== undefined || target.__ModuleLoader__ !== undefined) {
    throw new Error('官方 Harness ModuleLoader 已被其他浏览器运行时占用，不能混用 Conversation 运行时')
  }
  const facade: ModuleLoaderFacade = {
    mode: 'queue',
    pendingQueue: [...registrations.values()],
    load: (registration) => {
      registrations.set(normalizeId(registration.id), registration)
      if (facade.mode === 'queue') facade.pendingQueue.push(registration)
      else factories.set(normalizeId(registration.id), registration.factory)
    },
    create: (options) => {
      if (!createModuleSystem || !staticModules) throw new Error('官方 Harness Client 尚未预加载')
      // The bootstrap bundle is materialized explicitly below. It may also
      // have registered itself while being preloaded; the official module
      // system expects that bootstrap registration to be represented only by
      // `bootstrapModule`, otherwise it quite correctly reports a duplicate.
      const bootstrapKey = '@deepseek-ai/dsh-client-modules'
      for (let index = facade.pendingQueue.length - 1; index >= 0; index -= 1) {
        if (normalizeId(facade.pendingQueue[index]!.id) === bootstrapKey) facade.pendingQueue.splice(index, 1)
      }
      const system = createModuleSystem(facade, {
        id: '@deepseek-ai/dsh-client-modules',
        exports: requireOfficial('@deepseek-ai/dsh-client-modules/client'),
      }, options)
      facade.mode = 'live'
      return system
    },
  }
  target.__ModuleLoader__ = facade
  // AppWebEntry is compiled against globalThis while browser carriers load
  // through window. Keep both references identical so jsdom, Tauri webviews,
  // and real browsers all observe one official loader.
  host.__ModuleLoader__ = facade
  if (host.window !== undefined) host.window.__ModuleLoader__ = facade
  installed = true
}

async function importOfficialBundle(id: string): Promise<void> {
  if (factories.has(normalizeId(id))) return
  // The published package calls window.__ModuleLoader__.load during import.
  if (id === '@deepseek-ai/dsh-client-modules/client') await import('@deepseek-ai/dsh-client-modules/client')
  else if (id === '@deepseek-ai/dsh-client-connection/client') await import('@deepseek-ai/dsh-client-connection/client')
  else if (id === '@deepseek-ai/dsh-typert-registry/client') await import('@deepseek-ai/dsh-typert-registry/client')
  else if (id === '@deepseek-ai/dsh-api-gateway/client') await import('@deepseek-ai/dsh-api-gateway/client')
  else if (id === '@deepseek-ai/dsh-api-remotes/client') await import('@deepseek-ai/dsh-api-remotes/client')
  else if (id === '@deepseek-ai/dsh-client-file-upload/client') await import('@deepseek-ai/dsh-client-file-upload/client')
  else if (id === '@deepseek-ai/dsh-client-locale/client') await import('@deepseek-ai/dsh-client-locale/client')
  else if (id === '@deepseek-ai/dsh-client-ui-settings/client') await import('@deepseek-ai/dsh-client-ui-settings/client')
  else if (id === '@deepseek-ai/dsh-client-resources/client') await import('@deepseek-ai/dsh-client-resources/client')
  else if (id === '@deepseek-ai/dsh-client-ui-theme/client') await import('@deepseek-ai/dsh-client-ui-theme/client')
  else if (id === '@deepseek-ai/dsh-client-shortcuts/client') await import('@deepseek-ai/dsh-client-shortcuts/client')
  else if (id === '@deepseek-ai/dsh-api-workspace-controller/client') await import('@deepseek-ai/dsh-api-workspace-controller/client')
  else if (id === '@deepseek-ai/dsh-api-session-controller/client') await import('@deepseek-ai/dsh-api-session-controller/client')
  else if (id === '@deepseek-ai/dsh-client-ui-sidebar/client') await import('@deepseek-ai/dsh-client-ui-sidebar/client')
  else if (id === '@deepseek-ai/dsh-client-ui-sidebar-right/client') await import('@deepseek-ai/dsh-client-ui-sidebar-right/client')
  else if (id === '@deepseek-ai/dsh-client-ui-sidebar-browser/client') await import('@deepseek-ai/dsh-client-ui-sidebar-browser/client')
  else if (id === '@deepseek-ai/dsh-client-ui-workspace/client') await import('@deepseek-ai/dsh-client-ui-workspace/client')
  else if (id === '@deepseek-ai/dsh-client-ui-input-trigger/client') await import('@deepseek-ai/dsh-client-ui-input-trigger/client')
  else if (id === '@deepseek-ai/dsh-client-ui-conversation/client') await import('@deepseek-ai/dsh-client-ui-conversation/client')
  else if (id === '@deepseek-ai/dsh-client-ui-chat/client') await import('@deepseek-ai/dsh-client-ui-chat/client')
  else if (id === '@deepseek-ai/dsh-client-ui-session/client') await import('@deepseek-ai/dsh-client-ui-session/client')
  else if (id === '@deepseek-ai/dsh-client-ui-tool/client') await import('@deepseek-ai/dsh-client-ui-tool/client')
  else if (id === '@deepseek-ai/dsh-client-ui-approval/client') await import('@deepseek-ai/dsh-client-ui-approval/client')
  else if (id === '@deepseek-ai/dsh-client-ui-user-questions/client') await import('@deepseek-ai/dsh-client-ui-user-questions/client')
  else if (id === '@deepseek-ai/dsh-client-ui-trajectory/client') await import('@deepseek-ai/dsh-client-ui-trajectory/client')
  else if (id === '@deepseek-ai/dsh-client-ui-layout/client') await import('@deepseek-ai/dsh-client-ui-layout/client')
  else if (id === '@deepseek-ai/dsh-client-ui-renderer/client') await import('@deepseek-ai/dsh-client-ui-renderer/client')
  else throw new Error(`不支持的官方 Harness 浏览器包：${id}`)
  if (!registrations.has(normalizeId(id))) throw new Error(`官方 Harness 浏览器包未注册模块：${id}`)
}

function requireOfficial(id: string): Record<string, unknown> {
  const key = normalizeId(id)
  const cached = modules.get(key)
  if (cached !== undefined) return cached
  const factory = factories.get(key) ?? registrations.get(key)?.factory
  if (factory === undefined) {
    const standard = modules.get(id)
    if (standard !== undefined) return standard
    throw new Error(`官方 Harness 浏览器依赖未加载：${id}`)
  }
  // Carrier factories use CommonJS-style callable require for static
  // dependencies and expose `.async` for package-local chunks.
  const loader = ((dependency: string) => requireOfficial(dependency)) as ClientRequire
  loader.async = async (dependency: string) => requireOfficial(dependency)
  const value = factory(loader)
  modules.set(key, value)
  return value
}

function normalizeId(id: string): string {
  return id.endsWith('/client') ? id.slice(0, -'/client'.length) : id
}
