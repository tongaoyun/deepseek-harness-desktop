/** Product desktop authentication, native lifecycle, and credential-owning dispatch. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, safeStorage, screen, shell, type BrowserWindow } from 'electron'
import { DeepSeekHarnessProductBridge, type ProductBridgeOptions, type ProductRuntimeBootstrap } from '@deepseek-harness/product/bridge'
import { DeepSeekHarnessApiError } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import { ensureDingTalkSession, DingTalkAuthorizationTimeoutError } from '@deepseek-harness/product/dingtalk-auth'
import { isProductRuntimeMethod, type ProductSession } from '@deepseek-harness/product/protocol'
import { DeepSeekHarnessNativeProcess } from './deepseek-harness-native-process.ts'
import { resolveDeepSeekHarnessConnectorProxyPolicy, resolveDeepSeekHarnessKnowledgeFilePolicy, resolveDeepSeekHarnessProductServerUrl, resolveDesktopSupportPolicy } from './deepseek-harness-product-config.ts'
import { DesktopSupport } from './desktop-support.ts'
import { ConnectorProxy } from './connector-proxy.ts'
import { inferenceProfile } from './inference-profile.ts'
import { ExtensionAuthoring } from './extension-authoring.ts'
import { PersonalConnectors } from './personal-connectors.ts'
import { knowledgeUploadDialogOptions, KnowledgeUploads } from './knowledge-upload.ts'
import { KnowledgeFiles } from './knowledge-files.ts'
import { waitForNativeDialog } from './native-dialog.ts'
interface ExtensionContext {
  readonly getWindow: () => BrowserWindow | undefined
  readonly isQuitting: () => boolean
  readonly requestHost: (namespace: string, method: string, payload?: unknown, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>
}
interface ProductDesktopExtension {
  readonly namespace: string
  readonly ownsStartupDocument: boolean
  prepareHost(): Promise<NodeJS.ProcessEnv | undefined>
  invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  invokeRuntime(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  subscribe(listener: (event: unknown) => void): () => void
  focus(): Promise<void>
  close(): Promise<void>
}
function deepseekHarnessAuthenticationPage(): string {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>DeepSeek Harness</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#202124;background:#fff}
@media(prefers-color-scheme:dark){:root{color:#f2f3f5;background:#171817}}
body{min-height:100vh;margin:0;display:grid;place-items:center}.content{text-align:center;padding:32px}
.mark{width:42px;height:42px;margin:0 auto 24px;border:3px solid #dfe5e1;border-top-color:#1f8f5f;border-radius:50%;animation:spin .8s linear infinite}
h1{margin:0 0 10px;font-size:22px;font-weight:600;letter-spacing:0}p{margin:0;color:#777;font-size:14px;letter-spacing:0}
@media(prefers-color-scheme:dark){p{color:#aaa}.mark{border-color:#343936;border-top-color:#4bc58a}}@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><main class="content"><div class="mark" aria-hidden="true"></div><h1>正在连接钉钉</h1><p>请在系统浏览器中完成授权</p></main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

interface StoredDeepSeekHarnessSession {
  readonly version: number
  readonly session: ProductSession
  readonly encryptedToken: string
}

/** Restore the product session without exposing the opaque token to Renderer. */
function readStoredDeepSeekHarnessSession(): { session: ProductSession; token: string } | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'deepseek-harness-session.json'), 'utf8')) as StoredDeepSeekHarnessSession
    if (raw.version !== 1 || typeof raw.encryptedToken !== 'string' || raw.encryptedToken === '') return undefined
    const token = safeStorage.decryptString(Buffer.from(raw.encryptedToken, 'base64'))
    if (token === '') return undefined
    return { session: raw.session, token }
  } catch {
    return undefined
  }
}

/** Persist only an OS-encrypted token and its non-secret identity projection. */
function persistDeepSeekHarnessSession(session: ProductSession, token: string | undefined): void {
  const path = join(app.getPath('userData'), 'deepseek-harness-session.json')
  if (token === undefined || token === '') {
    rmSync(path, { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) return
  const encryptedToken = safeStorage.encryptString(token).toString('base64')
  writeFileSync(path, JSON.stringify({
    version: 1, session, encryptedToken,
  } satisfies StoredDeepSeekHarnessSession), { mode: 0o600 })
}


/** Create credential-owning desktop lifecycle hooks.
 * @param context Trusted shell access to its primary window and Host transport.
 * @returns Product extension; close cancels authentication and releases its native sidecar.
 */
export function createExtension(context: ExtensionContext): ProductDesktopExtension {
  const lifecycle = new AbortController()
  const storedDeepSeekHarnessSession = readStoredDeepSeekHarnessSession()
  const serverUrl = resolveDeepSeekHarnessProductServerUrl({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })
  const sessionToken = storedDeepSeekHarnessSession?.token ?? process.env.DEEPSEEK_HARNESS_SESSION_TOKEN
  const knowledgeFilePolicy = resolveDeepSeekHarnessKnowledgeFilePolicy({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(),
  })
  const knowledgeFiles = new KnowledgeFiles({
    directory: join(app.getPath('userData'), 'knowledge-files'),
    policy: knowledgeFilePolicy,
    getEmployeeId: () => productBridge.getSession().employeeId,
    renderOffice: (payload, signal) => context.requestHost('product', 'knowledge.documents.renderOffice', payload, signal,
      knowledgeFilePolicy.fileRequestTimeoutMs),
    saveDialog: async (filename) => {
      const window = context.getWindow()
      const options = { defaultPath: filename }
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
      return result.canceled ? undefined : result.filePath
    },
    openPath: path => shell.openPath(path),
  })
  let knowledgeFileEmployeeId = storedDeepSeekHarnessSession?.session.employeeId
  const knowledgeUploads = new KnowledgeUploads(() => productBridge.getSession().employeeId, async (mode, signal) => {
    const window = context.getWindow()
    const options = knowledgeUploadDialogOptions(mode)
    const selected = await waitForNativeDialog(() => window
      ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options), signal)
    return selected.canceled ? undefined : selected.filePaths[0]
  }, knowledgeFilePolicy.uploadMaxBytes)
  const nativeSidecar = new DeepSeekHarnessNativeProcess(
    process.env.DEEPSEEK_HARNESS_NATIVE_BINARY
      ?? (app.isPackaged ? join(process.resourcesPath, 'native', process.platform === 'win32' ? 'deepseek-harness-native.exe' : 'deepseek-harness-native') : undefined),
    join(app.getPath('userData'), 'native'),
  )
  const supportPolicy = resolveDesktopSupportPolicy({ packaged: app.isPackaged,
    resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  const support = new DesktopSupport({ policy: supportPolicy,
    native: (method, input, signal) => nativeSidecar.invoke(method, input, signal),
    metadata: () => ({ desktopVersion: app.getVersion(), platform: process.platform, architecture: process.arch,
      displayScalePercents: screen.getAllDisplays().map(display => Math.round(display.scaleFactor * 100)),
      encryptedStorage: safeStorage.isEncryptionAvailable() }),
  })
  const personalConnectors = new PersonalConnectors(join(app.getPath('userData'), 'personal-connectors'), safeStorage,
    () => productBridge.getSession().employeeId, async (id, signal) => {
      const value = await productBridge.invokeRuntime('connectors.list', { ids: [id] }, signal)
      const entries: readonly unknown[] = Array.isArray(value) ? value : []
      return entries.find(entry => typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === id)
    })
  const authoring = new ExtensionAuthoring({
    manageConnector: (method, input, api, employee, signal) => personalConnectors.manage(method, input, api, employee, signal),
    directory: join(app.getPath('userData'), 'extension-conversations-v1'),
    selectImport: async (source, kind) => {
      const window = context.getWindow()
      const options = { properties: source === 'directory' ? ['openDirectory' as const] : ['openFile' as const],
        ...(source !== 'directory' ? { filters: [{ name: kind === 'skill' && source === 'file' ? 'ZIP / SKILL.md' : 'ZIP',
          extensions: kind === 'skill' && source === 'file' ? ['zip', 'md'] : ['zip'] }] } : {}) }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    installSkill: async (id, signal) => {
      await productBridge.invoke('skills.install', { id }, signal)
    },
    saveConnector: (draft, api, employee, signal) => personalConnectors.save(draft, api, employee, signal),
  })
  const productBridgeOptions: ProductBridgeOptions = {
    support: (method, input, api, session, signal) => support.invoke(method, input, api, session, signal),
    knowledgeFiles: (method, input, api, session, signal) => knowledgeFiles.invoke(method, input, api, session, signal),
    knowledgeUpload: knowledgeUploads,
    desktopVersion: app.getVersion(),
    persistSession: async (session, token) => {
      persistDeepSeekHarnessSession(session, token)
      const employeeId = session.authenticated ? session.employeeId : undefined
      if (employeeId !== knowledgeFileEmployeeId) {
        knowledgeFileEmployeeId = employeeId
        knowledgeUploads.resetIdentity()
        await knowledgeFiles.resetIdentity()
      }
      await personalConnectors.resetIdentity(session.authenticated ? session.employeeId : undefined)
    },
    serverUrl,
    sessionToken,
    initialSession: storedDeepSeekHarnessSession?.session,
    nativeInvoke: (method, payload, signal) => nativeSidecar.invoke(method, payload, signal),
    taskCapabilities: (method, payload, signal) => context.requestHost('product', 'tasks.capabilities.' + method, payload, signal),
    installedSkills: (method, payload, signal) => context.requestHost('product',
      method === 'read' ? 'skills.installed.read' : 'skills.' + method, payload, signal),
    installedExpertKits: (method, payload, signal) => context.requestHost('product',
      method === 'read' ? 'expertKits.installed.read' : 'expertKits.' + method, payload, signal),
    authoring: (method, payload, api, session, signal) => authoring.invoke(method, payload, api, session, signal ?? lifecycle.signal),
    connectorRuntime: (value, signal, discoverTools) => personalConnectors.enrich(value, signal, discoverTools),
  }
  const productBridge = new DeepSeekHarnessProductBridge(productBridgeOptions)
  const connectorProxy = new ConnectorProxy((signal, ids) => productBridge.readConnectorTransports(ids, signal),
    (request, response, connector, signal) => personalConnectors.serveStdio(request, response, connector, signal),
    resolveDeepSeekHarnessConnectorProxyPolicy({ packaged: app.isPackaged,
      resourcesPath: process.resourcesPath, appPath: app.getAppPath() }))
  let deepseekHarnessAuthAttempt: { readonly controller: AbortController; readonly owners: Set<symbol>; promise: Promise<void> } | undefined
  const authenticationOperations = new Set<Promise<void>>()
  let deepseekHarnessAuthenticationVisible = false
  const showDeepSeekHarnessAuthentication = async (): Promise<void> => {
    const window = context.getWindow()
    if (window === undefined || window.isDestroyed()) return
    await window.loadURL(deepseekHarnessAuthenticationPage())
    deepseekHarnessAuthenticationVisible = true
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  const ensureDeepSeekHarnessAuth = async (showStatusPage = true, signal?: AbortSignal): Promise<void> => {
    const caller = AbortSignal.any([lifecycle.signal, ...signal ? [signal] : []])
    caller.throwIfAborted()
    if (deepseekHarnessAuthAttempt === undefined) {
      const controller = new AbortController()
      const attempt = { controller, owners: new Set<symbol>(), promise: Promise.resolve() }
      deepseekHarnessAuthAttempt = attempt
      attempt.promise = ensureDingTalkSession(productBridge, async (url) => {
        if (showStatusPage) await showDeepSeekHarnessAuthentication()
        await shell.openExternal(url)
      }, { timeoutMs: 5 * 60_000, signal: AbortSignal.any([controller.signal, lifecycle.signal]) })
        .then(() => { if (deepseekHarnessAuthAttempt === attempt) deepseekHarnessAuthenticationVisible = false })
        .finally(() => {
          if (deepseekHarnessAuthAttempt === attempt) deepseekHarnessAuthAttempt = undefined
          authenticationOperations.delete(attempt.promise)
        })
      authenticationOperations.add(attempt.promise)
    }
    const attempt = deepseekHarnessAuthAttempt
    const owner = Symbol()
    attempt.owners.add(owner)
    let cancel: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        cancel = () => {
          reject(caller.reason instanceof Error ? caller.reason : new Error('DingTalk sign-in cancelled', { cause: caller.reason }))
        }
        caller.addEventListener('abort', cancel, { once: true })
        attempt.promise.then(resolve, reject)
      })
      caller.throwIfAborted()
    } finally {
      if (cancel !== undefined) caller.removeEventListener('abort', cancel)
      attempt.owners.delete(owner)
      if (attempt.owners.size === 0 && deepseekHarnessAuthAttempt === attempt) {
        deepseekHarnessAuthAttempt = undefined
        attempt.controller.abort(new Error('DingTalk sign-in is no longer requested'))
      }
    }
  }
  const prepareDeepSeekHarnessBootstrap = async (): Promise<ProductRuntimeBootstrap | undefined> => {
    let operation = '钉钉登录'
    const stopped = (): boolean => context.isQuitting() || lifecycle.signal.aborted
    while (!stopped()) {
      try {
        operation = '钉钉登录'
        await ensureDeepSeekHarnessAuth()
        operation = '加载工作区配置'
        return await productBridge.loadRuntimeBootstrap()
      } catch (error) {
        if (stopped()) return undefined
        const expired = error instanceof DingTalkAuthorizationTimeoutError
        const unauthorized = error instanceof DeepSeekHarnessApiError
          && error.status === 401 && error.code === 'EMPLOYEE_UNAUTHORIZED'
        if (unauthorized) continue
        const unavailable = error instanceof ProductError && (error.code === 'PRODUCT_NETWORK_UNAVAILABLE'
          || error instanceof DeepSeekHarnessApiError && (error.status >= 500 || error.status === 429))
        if (!expired && !unavailable) throw error
        const options = {
          type: 'warning' as const, title: '暂时无法进入工作区',
          message: expired ? '钉钉登录已超时' : `${operation}失败，暂时无法连接服务`,
          detail: expired ? '请重试并在浏览器中完成钉钉授权。' : '请检查网络连接后重试。工作区尚未启动，已有任务和登录数据已保留。',
          buttons: ['重试', '退出'], defaultId: 0, cancelId: 1,
        }
        const window = context.getWindow()
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        const result = await waitForNativeDialog(() => window && !window.isDestroyed()
          ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options), lifecycle.signal).catch((error: unknown) => {
          if (!lifecycle.signal.aborted) throw error
          return { response: 1 }
        })
        if (stopped()) return undefined
        if (result.response !== 0) { app.quit(); return undefined }
      }
    }
    return undefined
  }

  let closed = false
  let supportTimer: ReturnType<typeof setInterval> | undefined
  const operations = new Set<Promise<unknown>>()
  const track = <T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const combined = AbortSignal.any([lifecycle.signal, ...signal === undefined ? [] : [signal]])
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined) })
    operations.add(pending)
    void pending.finally(() => operations.delete(pending)).catch(() => undefined)
    return pending
  }
  const reportDevice = (): void => {
    void track(undefined, signal => productBridge.invoke('support.device.report', {}, signal)).catch(() => {
      // DesktopSupport retains a visible degraded status; reporting must not block conversations.
    })
  }
  return {
    namespace: 'product',
    get ownsStartupDocument() { return deepseekHarnessAuthenticationVisible },
    async prepareHost(): Promise<NodeJS.ProcessEnv | undefined> {
      await knowledgeFiles.prepare()
      await connectorProxy.start()
      await nativeSidecar.start()
      const bootstrap = await prepareDeepSeekHarnessBootstrap()
      if (closed || bootstrap === undefined) return undefined
      reportDevice()
      if (supportTimer === undefined) {
        supportTimer = setInterval(reportDevice, supportPolicy.heartbeatIntervalMs)
        supportTimer.unref()
      }
      const modelProfile = join(app.getPath('userData'), 'product-inference.patch.json')
      writeFileSync(modelProfile, JSON.stringify(inferenceProfile(bootstrap,
        fileURLToPath(import.meta.resolve('@deepseek-harness/product-runtime/inference-default')))), { mode: 0o600 })
      return {
        DEEPSEEK_HARNESS_SESSION_TOKEN: undefined,
        DEEPSEEK_API_KEY: bootstrap.modelApiKey,
        DEEPSEEK_BASE_URL: bootstrap.endpoints.litellm,
        DSH_DESKTOP_PROFILE_PATCHES: JSON.stringify([
          fileURLToPath(import.meta.resolve('@deepseek-harness/product-runtime/cordis.patch.yml')),
          fileURLToPath(import.meta.resolve('@deepseek-harness/product-ui/cordis.patch.yml')),
          modelProfile,
        ]),
      }
    },
    async invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
      return track(signal, async (signal) => {
        if (closed) throw new Error('Product extension is closed')
        if (method === 'auth.ensureDingTalk') {
          await ensureDeepSeekHarnessAuth(false, signal)
          return productBridge.getSession()
        }
        const result = await productBridge.invoke(method, payload, signal)
        if ((method === 'auth.beginDingTalk' || method === 'connectors.authorization.begin')
        && typeof result === 'object' && result !== null && 'authorizationUrl' in result && typeof result.authorizationUrl === 'string') {
          const url = new URL(result.authorizationUrl)
          if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid authorization URL')
          await shell.openExternal(url.href)
        }
        return result
      })
    },
    async invokeRuntime(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
      return track(signal, async (signal) => {
        if (closed || !isProductRuntimeMethod(method)) return Promise.reject(new Error('Unsupported runtime operation'))
        const result = await productBridge.invokeRuntime(method, payload, signal)
        return method === 'connectors.list' ? connectorProxy.catalog(result) : result
      })
    },
    subscribe: (listener: (event: unknown) => void) => productBridge.subscribe(listener),
    focus: () => track(undefined, async (signal) => { reportDevice(); await productBridge.refreshCatalog(signal) }),
    async close(): Promise<void> {
      closed = true
      if (supportTimer !== undefined) clearInterval(supportTimer)
      lifecycle.abort(new Error('Product extension is closed'))
      knowledgeUploads.close()
      await productBridge.dispose()
      await support.close()
      await knowledgeFiles.close()
      await connectorProxy.close()
      await personalConnectors.close()
      await authoring.close()
      await nativeSidecar.stop()
      await Promise.allSettled([...operations])
      await Promise.allSettled([...authenticationOperations])
    },
  }
}
