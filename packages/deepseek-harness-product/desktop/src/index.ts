/** Product desktop authentication, resource lifecycle, and credential-owning dispatch. */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, safeStorage, screen, shell, type BrowserWindow } from 'electron'
import { DeepSeekHarnessProductBridge, type ProductBridgeOptions, type ProductRuntimeBootstrap } from '@deepseek-harness/product/bridge'
import { DeepSeekHarnessApiError } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import { EMPLOYEE_AUTH_CLASS_NAME, EMPLOYEE_AUTH_COPY, EMPLOYEE_AUTH_CSS } from '@deepseek-harness/product/auth-screen'
import { ensureDingTalkSession, DingTalkAuthorizationTimeoutError } from '@deepseek-harness/product/dingtalk-auth'
import { DINGTALK_AUTHORIZATION_TIMEOUT_MS, isProductRuntimeMethod, type ProductSession } from '@deepseek-harness/product/protocol'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { resolveDeepSeekHarnessProductConfig } from './deepseek-harness-product-config.ts'
import { DesktopSupport } from './desktop-support.ts'
import { ConnectorProxy } from './connector-proxy.ts'
import { CompanyContentSync, waitForCompanyContent } from './company-content-sync.ts'
import { z } from 'zod'
import { builtinCapabilityPatches } from './builtin-capabilities.ts'
import { inferenceProfile } from './inference-profile.ts'
import { prepareNativeCapabilities } from './native-capabilities.ts'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { PersonalConnectors } from './personal-connectors.ts'
import { confirmConnectorReleaseReceipt } from './connector-receipts.ts'
import { LibraryUploads } from './library-upload.ts'
import { LibraryFiles } from './library-files.ts'
import { waitForNativeDialog } from './native-dialog.ts'
interface ExtensionContext {
  readonly getWindow: () => BrowserWindow | undefined
  readonly isQuitting: () => boolean
  readonly requestHost: (namespace: string, method: string, payload?: unknown, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>
}
interface ProductDesktopExtension {
  readonly namespace: string
  readonly ownsStartupDocument: boolean
  prepareHost(profile: { readonly directory: string; readonly installAnchor: string }): Promise<NodeJS.ProcessEnv | undefined>
  invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  invokeRuntime(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  subscribe(listener: (event: unknown) => void): () => void
  focus(): Promise<void>
  close(): Promise<void>
}
function deepseekHarnessAuthenticationPage(): string {
  const copy = EMPLOYEE_AUTH_COPY.zh
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>DeepSeek Harness</title><style>body{margin:0}${EMPLOYEE_AUTH_CSS}</style></head>
<body><div class="${EMPLOYEE_AUTH_CLASS_NAME}"><main><div data-product-auth-mark="pending" aria-hidden="true"></div>
<h1>${copy.connecting}</h1><p>${copy.hint}</p></main></div></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

const StoredDeepSeekHarnessSessionSchema = z.object({
  version: z.literal(2),
  serverUrl: z.url(),
  session: z.object({
    authenticated: z.literal(true), employeeId: z.string().min(1).max(256),
    displayName: z.string().max(256).optional(),
    expiresAt: z.string().regex(/^\d+$/), loginExpiresAt: z.string().regex(/^\d+$/),
  }).strict(),
  encryptedCredentials: z.string().min(1),
}).strict()
const StoredCredentialsSchema = z.object({ token: z.string().min(1).max(128), refreshToken: z.string().min(1).max(128) }).strict()

/** Restore main-owned credentials only for their issuing server. */
function readStoredDeepSeekHarnessSession(serverUrl: string): { session: ProductSession; token: string; refreshToken: string } | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    const raw = StoredDeepSeekHarnessSessionSchema.parse(
      JSON.parse(readFileSync(join(app.getPath('userData'), 'deepseek-harness-session.json'), 'utf8')))
    if (raw.serverUrl !== serverUrl) return undefined
    const credentials = StoredCredentialsSchema.parse(JSON.parse(
      safeStorage.decryptString(Buffer.from(raw.encryptedCredentials, 'base64'))))
    return { session: { authenticated: true, employeeId: raw.session.employeeId, expiresAt: raw.session.expiresAt,
      loginExpiresAt: raw.session.loginExpiresAt,
      ...raw.session.displayName === undefined ? {} : { displayName: raw.session.displayName } }, ...credentials }
  } catch {
    return undefined
  }
}

/** Atomically replace OS-encrypted credentials; a failed write preserves the last complete login. */
function persistDeepSeekHarnessSession(serverUrl: string, session: ProductSession, token: string | undefined,
  refreshToken: string | undefined): void {
  const path = join(app.getPath('userData'), 'deepseek-harness-session.json')
  if (!session.authenticated || !token || !refreshToken) { rmSync(path, { force: true }); return }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable')
  const encryptedCredentials = safeStorage.encryptString(JSON.stringify({ token, refreshToken })).toString('base64')
  const stored = StoredDeepSeekHarnessSessionSchema.parse({ version: 2, serverUrl, session, encryptedCredentials })
  const temporary = path + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** Create credential-owning desktop lifecycle hooks.
 * @param context Trusted shell access to its primary window and Host transport.
 * @returns Product extension; close joins owned work and releases all resources before reporting cleanup failures.
 */
export function createExtension(context: ExtensionContext): ProductDesktopExtension {
  const lifecycle = new AbortController()
  const operations = new Set<Promise<unknown>>()
  const config = resolveDeepSeekHarnessProductConfig({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  const storedDeepSeekHarnessSession = readStoredDeepSeekHarnessSession(config.serverUrl)
  const sessionToken = storedDeepSeekHarnessSession?.token
  const libraryFilePolicy = config.libraryFiles
  const libraryFiles = new LibraryFiles({
    directory: join(app.getPath('userData'), 'library-files'),
    policy: libraryFilePolicy,
    getEmployeeId: () => productBridge.getSession().employeeId,
    renderOffice: (payload, signal) => context.requestHost('product', 'library.files.renderOffice', payload, signal,
      libraryFilePolicy.fileRequestTimeoutMs),
    saveDialog: async (filename) => {
      const window = context.getWindow()
      const options = { defaultPath: filename }
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
      return result.canceled ? undefined : result.filePath
    },
    openPath: path => shell.openPath(path),
  })
  let libraryFileEmployeeId = storedDeepSeekHarnessSession?.session.employeeId
  let employeeLifecycle = new AbortController()
  let hostEmployeeId: string | undefined
  let companyContent: { readonly sync: CompanyContentSync; readonly ready: Promise<void> } | undefined
  let companyContentCleanup = Promise.resolve()
  const closeCompanyContent = (): Promise<void> => {
    const previous = companyContent
    companyContent = undefined
    if (!previous) return Promise.resolve()
    const closing = previous.sync.close()
    companyContentCleanup = Promise.all([companyContentCleanup, closing]).then(() => undefined)
    void companyContentCleanup.catch(() => { /* The closing caller reports failure; future initialization remains blocked. */ })
    return closing
  }
  const libraryUploads = new LibraryUploads(() => productBridge.getSession().employeeId, async (signal, mode) => {
    const window = context.getWindow()
    const options: import('electron').OpenDialogOptions = { properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'] }
    const selected = await waitForNativeDialog(() => window
      ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options), signal)
    return selected.canceled ? undefined : selected.filePaths
  }, libraryFilePolicy.uploadMaxBytes, libraryFilePolicy.transferLifetimeMs, (payload, signal) => context.requestHost('product', 'library.files.archive.read', payload, signal, libraryFilePolicy.fileRequestTimeoutMs))
  const supportPolicy = config.support
  const support = new DesktopSupport({ policy: supportPolicy,
    installationId: getOrCreateAnonymousUserId(),
    metadata: () => ({ desktopVersion: app.getVersion(), platform: process.platform, architecture: process.arch,
      displayScalePercents: screen.getAllDisplays().map(display => Math.round(display.scaleFactor * 100)),
      encryptedStorage: safeStorage.isEncryptionAvailable() }),
  })
  const personalConnectors = new PersonalConnectors(join(app.getPath('userData'), 'personal-connectors'), safeStorage,
    () => productBridge.getSession().employeeId, async (id, signal) => {
      const value = await productBridge.invokeRuntime('connectors.list', { ids: [id] }, signal)
      const entries: readonly unknown[] = Array.isArray(value) ? value : []
      return entries.find(entry => typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === id)
    }, () => { productBridge.invalidateConnectorCatalog() })
  const productBridgeOptions: ProductBridgeOptions = {
    support: (method, input, api, session, signal) => support.invoke(method, input, api, session, signal),
    libraryFiles: (method, input, api, session, signal) => {
      const lifetime = signal ?? lifecycle.signal
      if (method.startsWith('library.files.upload') || method === 'library.files.archive.select') {
        const employee = session.employeeId
        if (employee === undefined) throw new Error('Authenticated employee required')
        return libraryUploads.invoke(method, input, api, employee, lifetime)
      }
      return libraryFiles.invoke(method, input, api, session, lifetime)
    },
    persistSession: (session, token, refreshToken) => {
      const employeeId = session.authenticated ? session.employeeId : undefined
      const pending: Promise<void>[] = []
      if (employeeId !== libraryFileEmployeeId) {
        pending.push(closeCompanyContent())
        libraryFileEmployeeId = employeeId
        employeeLifecycle.abort(new Error('Employee identity changed'))
        employeeLifecycle = new AbortController()
        libraryUploads.resetIdentity()
        pending.push(libraryFiles.resetIdentity())
      }
      pending.push(connectorProxy.resetIdentity(employeeId))
      pending.push(personalConnectors.resetIdentity(employeeId))
      pending.push(Promise.resolve().then(() => { persistDeepSeekHarnessSession(config.serverUrl, session, token, refreshToken) }))
      const operation = Promise.allSettled(pending).then((results) => {
        const errors: unknown[] = []
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
        if (errors.length > 0) throw new AggregateError(errors, 'Employee session persistence or resource cleanup failed')
      })
      operations.add(operation)
      void operation.finally(() => operations.delete(operation)).catch(() => undefined)
      return operation
    },
    serverUrl: config.serverUrl,
    sessionToken,
    refreshToken: storedDeepSeekHarnessSession?.refreshToken,
    initialSession: storedDeepSeekHarnessSession?.session,
    connectorManagement: async (method, payload, api, session, signal) => {
      const lifetime = signal ?? lifecycle.signal
      const employee = session.employeeId
      if (!employee) throw new Error('Authenticated employee is required')
      if (method.startsWith('extensions.connector.')) return personalConnectors.manage(method, payload, api, employee, lifetime)
      if (method === 'extensions.save') {
        const draft = ConnectorDraftSchema.parse(payload)
        await personalConnectors.save(draft, api, employee, lifetime)
        return { kind: 'connector', id: draft.id, version: draft.version, visibility: 'PERSONAL' }
      }
      if (method === 'extensions.submit') {
        const { id, version } = payload
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(id)
          || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid connector coordinate')
        const receipt = await api.request(`/api/v1/extension-submissions/connector/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/submissions`, { method: 'POST', signal: lifetime })
        lifetime.throwIfAborted()
        confirmConnectorReleaseReceipt(receipt, { id, version, employeeId: employee }, true)
        return { id, version, submitted: true }
      }
      throw new Error('Unsupported connector management operation')
    },
    connectorRuntime: (value, signal, discoverTools) => personalConnectors.enrich(value, signal, discoverTools),
  }
  const productBridge = new DeepSeekHarnessProductBridge(productBridgeOptions)
  const connectorProxy = new ConnectorProxy((signal, ids) => productBridge.readConnectorTransports(ids, signal),
    (request, response, connector, signal) => personalConnectors.serveStdio(request, response, connector, signal),
    config.connectorProxy)
  void connectorProxy.resetIdentity(productBridge.getSession().employeeId)
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
      }, { timeoutMs: DINGTALK_AUTHORIZATION_TIMEOUT_MS, signal: AbortSignal.any([controller.signal, lifecycle.signal]) })
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
  const prepareDeepSeekHarnessBootstrap = async (): Promise<{
    bootstrap: ProductRuntimeBootstrap
    employeeId: string
    signal: AbortSignal
  } | undefined> => {
    let operation = '钉钉登录'
    const stopped = (): boolean => context.isQuitting() || lifecycle.signal.aborted
    while (!stopped()) {
      try {
        operation = '钉钉登录'
        await ensureDeepSeekHarnessAuth()
        const employeeId = productBridge.getSession().employeeId
        if (!employeeId) throw new Error('Authenticated employee is required')
        const signal = employeeLifecycle.signal
        operation = '加载工作区配置'
        const bootstrap = await productBridge.loadRuntimeBootstrap()
        signal.throwIfAborted()
        return { bootstrap, employeeId, signal }
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
  let closePromise: Promise<void> | undefined
  let preparePromise: Promise<NodeJS.ProcessEnv | undefined> | undefined
  let supportTimer: ReturnType<typeof setInterval> | undefined
  const track = <T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const combined = AbortSignal.any([lifecycle.signal, ...signal === undefined ? [] : [signal]])
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined) })
    operations.add(pending)
    void pending.finally(() => operations.delete(pending)).catch(() => undefined)
    return pending
  }
  const ensureCompanyContent = async (employeeId: string, signal: AbortSignal): Promise<CompanyContentSync> => {
    signal.throwIfAborted()
    if (companyContent === undefined) {
      const identity = employeeLifecycle.signal
      const assertIdentity = (): void => {
        identity.throwIfAborted()
        const session = productBridge.getSession()
        if (!session.authenticated || session.employeeId !== employeeId) {
          throw new ProductError('PRODUCT_HOST_IDENTITY_CHANGED', '员工身份已变化，请重启桌面端后继续。', false)
        }
      }
      const sync = new CompanyContentSync({ root: join(app.getPath('userData'), 'company-content-v2'), employeeId,
        refreshIntervalMs: config.companyContentRefreshIntervalMs,
        loadResource: async (ref, signal) => {
          assertIdentity()
          const value = await productBridge.loadCompanyResource(ref, signal)
          assertIdentity()
          return value
        },
        load: async (signal) => {
          assertIdentity()
          const value = await productBridge.loadCompanyContent(signal)
          assertIdentity()
          return value
        } })
      const cleanup = companyContentCleanup
      const ready = track(identity, async (signal) => {
        try {
          await waitForCompanyContent(cleanup, signal)
          assertIdentity()
          await sync.prepare()
          signal.throwIfAborted()
        } catch (error) {
          if (companyContent?.sync === sync) {
            try { await closeCompanyContent() }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Company content preparation and cleanup failed') }
          }
          throw error
        }
      })
      companyContent = { sync, ready }
    }
    const owner = companyContent
    await waitForCompanyContent(owner.ready, signal)
    signal.throwIfAborted()
    return owner.sync
  }
  const reportDevice = (): void => {
    void track(undefined, signal => productBridge.invoke('support.device.report', {}, signal)).catch(() => {
      // DesktopSupport retains a visible degraded status; reporting must not block conversations.
    })
  }
  return {
    namespace: 'product',
    get ownsStartupDocument() { return deepseekHarnessAuthenticationVisible },
    prepareHost(profile): Promise<NodeJS.ProcessEnv | undefined> {
      if (preparePromise !== undefined) return preparePromise
      const operation = track(undefined, async (signal) => {
        await libraryFiles.prepare()
        signal.throwIfAborted()
        await connectorProxy.start()
        signal.throwIfAborted()
        const prepared = await prepareDeepSeekHarnessBootstrap()
        if (closed || prepared === undefined) return undefined
        const { bootstrap, employeeId } = prepared
        const identitySignal = AbortSignal.any([signal, prepared.signal])
        identitySignal.throwIfAborted()
        if (hostEmployeeId !== undefined && hostEmployeeId !== employeeId) {
          throw new ProductError('PRODUCT_HOST_IDENTITY_CHANGED', '员工身份已变化，请重启桌面端后继续。', false)
        }
        const sync = await ensureCompanyContent(employeeId, identitySignal)
        const roots = sync.read()
        identitySignal.throwIfAborted()
        await prepareNativeCapabilities(profile, { signal: identitySignal })
        identitySignal.throwIfAborted()
        reportDevice()
        if (supportTimer === undefined) {
          supportTimer = setInterval(reportDevice, supportPolicy.heartbeatIntervalMs)
          supportTimer.unref()
        }
        const modelProfile = join(app.getPath('userData'), 'product-inference.patch.json')
        writeFileSync(modelProfile, JSON.stringify(inferenceProfile(bootstrap,
          fileURLToPath(import.meta.resolve('@deepseek-harness/product-runtime/inference-default')))), { mode: 0o600 })
        const builtinCapabilities = join(app.getPath('userData'), 'product-builtin-capabilities.patch.json')
        writeFileSync(builtinCapabilities, JSON.stringify(builtinCapabilityPatches()), { mode: 0o600 })
        identitySignal.throwIfAborted()
        hostEmployeeId = employeeId
        return {
          DSH_COMPANY_SKILLS_ROOT: roots.skillsRoot,
          DSH_COMPANY_EXPERTS_ROOT: roots.expertsRoot,
          DEEPSEEK_HARNESS_SESSION_TOKEN: undefined,
          DSH_PRODUCT_MODEL_API_KEY: bootstrap.modelApiKey,
          DSH_DESKTOP_PROFILE_PATCHES: JSON.stringify([
            fileURLToPath(import.meta.resolve('@deepseek-harness/product-runtime/cordis.patch.yml')),
            fileURLToPath(import.meta.resolve('@deepseek-harness/product-ui/cordis.patch.yml')),
            builtinCapabilities,
            modelProfile,
          ]),
        }
      })
      const prepared = operation.catch((error: unknown) => {
        if (lifecycle.signal.aborted || closed) return undefined
        throw error
      })
      preparePromise = prepared
      void prepared.finally(() => { if (preparePromise === prepared) preparePromise = undefined }).catch(() => undefined)
      return prepared
    },
    async invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
      return track(signal, async (signal) => {
        if (closed) throw new Error('Product extension is closed')
        if (method === 'auth.ensureDingTalk') {
          await ensureDeepSeekHarnessAuth(false, signal)
          return productBridge.getSession()
        }
        if (method === 'connectors.refresh') {
          if (!productBridge.getSession().authenticated) throw new ProductError('EMPLOYEE_UNAUTHORIZED', '请先登录钉钉。', false)
          const input = z.object({}).strict().parse(payload ?? {})
          return context.requestHost('product', 'connectors.refresh', input, signal)
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
      const identitySignal = employeeLifecycle.signal
      return track(AbortSignal.any([identitySignal, ...signal === undefined ? [] : [signal]]), async (signal) => {
        if (closed || !isProductRuntimeMethod(method)) return Promise.reject(new Error('Unsupported runtime operation'))
        const session = productBridge.getSession()
        if (!session.authenticated) throw new ProductError('EMPLOYEE_UNAUTHORIZED', '请先登录钉钉。', false)
        if (hostEmployeeId === undefined || session.employeeId !== hostEmployeeId) {
          throw new ProductError('PRODUCT_HOST_IDENTITY_CHANGED', '员工身份已变化，请重启桌面端后继续。', false)
        }
        if (method.startsWith('runtime.companyContent.')) {
          const sync = await ensureCompanyContent(hostEmployeeId, signal)
          signal.throwIfAborted()
          if (method === 'runtime.companyContent.read') return sync.read()
          if (method === 'runtime.companyContent.refresh') { await sync.refresh(signal); signal.throwIfAborted(); return sync.read() }
          if (method === 'runtime.companyContent.expertVersion') {
            const request = z.object({ slug: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(payload)
            const result = await sync.expertVersion(request.slug, request.sha256, signal)
            signal.throwIfAborted()
            return result
          }
          const request = z.object({ sessionId: z.string().min(1).max(256),
            parentSessionId: z.string().min(1).max(256).optional(), started: z.boolean() }).strict().parse(payload)
          const result = await sync.pin(request, signal)
          signal.throwIfAborted()
          return result
        }
        const result = await productBridge.invokeRuntime(method, payload, signal)
        signal.throwIfAborted()
        return method === 'connectors.list' ? connectorProxy.catalog(result) : result
      })
    },
    subscribe: (listener: (event: unknown) => void) => productBridge.subscribe(listener),
    focus: () => track(undefined, async (signal) => { reportDevice(); await productBridge.refreshCatalog(signal) }),
    async close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      closePromise = (async () => {
        closed = true
        if (supportTimer !== undefined) clearInterval(supportTimer)
        lifecycle.abort(new Error('Product extension is closed'))
        const errors: unknown[] = []
        const cleanup = async (close: () => void | Promise<void>): Promise<void> => {
          try { await close() } catch (error: unknown) { errors.push(error) }
        }
        await cleanup(() => { libraryUploads.close() })
        await cleanup(closeCompanyContent)
        await cleanup(() => productBridge.dispose())
        await cleanup(() => support.close())
        await cleanup(() => libraryFiles.close())
        await cleanup(() => connectorProxy.close())
        await cleanup(() => personalConnectors.close())
        await Promise.allSettled([...operations])
        await Promise.allSettled([...authenticationOperations])
        if (errors.length > 0) throw new AggregateError(errors, 'Product extension cleanup failed')
      })()
      return closePromise
    },
  }
}
