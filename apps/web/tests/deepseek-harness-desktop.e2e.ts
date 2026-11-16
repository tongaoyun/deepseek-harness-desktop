/** Built and privately installed Electron acceptance with an isolated product service. */
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { watchConsole } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'
import { prepareDevelopmentProject } from '../../desktop/scripts/development-project.ts'
import { developmentRuntimeDirectory, resolveDesktopBuildTarget } from '../../desktop/scripts/desktop-build-paths.mjs'
import { createPluginProfile } from '../../desktop/src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../desktop/src/host-protocol.ts'
import { parseDesktopRelease } from '../../desktop/src/release.ts'
import { contentIndex } from '../../../packages/deepseek-harness-product/product/tests/content-fixtures.ts'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { closeElectronAcceptance } from '../../product-desktop/scripts/close-electron.mjs'
import { dialogWithButton, prepareNativeProductUpdate, type NativeProductUpdateQualification } from '../../product-desktop/tests/native-product-update.mjs'

const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')

async function fixtureRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const value of request) {
    const chunk: unknown = value
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected JSON bytes')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}

async function openEmployeeMenu(page: Page): Promise<void> {
  await page.locator('button[data-collapsed][aria-haspopup="menu"]').click()
}


interface DesktopSmokeBridge {
  extensions: { invoke(namespace: string, method: string, payload?: object): Promise<unknown> }
}

const desktopCarriers: { mode: 'official' | 'product'; installed?: string; surface?: 'support' }[] = [
  { mode: 'official' }, { mode: 'product' }, { mode: 'product', surface: 'support' },
]
if (process.env.DSH_INSTALLED_EXECUTABLE) desktopCarriers.push({ mode: 'product', installed: process.env.DSH_INSTALLED_EXECUTABLE })
for (const { mode, installed, surface } of desktopCarriers) {
  const carrier = installed === undefined ? 'built' : 'installed'
  it.skipIf(process.env.DSH_DESKTOP_SMOKE !== '1' || (process.platform !== 'darwin' && process.platform !== 'win32'))(
    surface === 'support' ? 'checks updates and submits pasted feedback in the built product desktop'
      : `boots the ${carrier} ${mode} Electron assembly with an isolated profile`, async () => {
      const root = await mkdtemp(join(tmpdir(), `product-desktop-${mode}-`))
      const home = join(root, 'home')
      const userData = join(root, 'electron')
      const project = join(root, 'runtime')
      const secret = 'fixture-employee-secret'
      const refreshSecret = 'fixture-remembered-login'
      const expiresAt = Math.floor(Date.now() / 1000) + 3600
      const refreshExpiresAt = Math.floor(Date.now() / 1000) + 2592000
      const employeeSession = { sessionToken: secret, expiresAt, refreshToken: refreshSecret, refreshExpiresAt,
        employee: { employeeId: 'fixture-employee', employeeName: 'Fixture user', teamId: '' } }
      const model = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
        successText: 'Fixture review complete.', apiKey: 'fixture-model-key' })
      onTestFinished(() => model.close())
      const libraryId = '11111111-1111-4111-8111-111111111111'
      const library = { id: libraryId, name: 'Operations playbook', description: 'Reference files', scope: 'TEAM',
        ownerId: 'fixture-company', companyId: 'company', role: 'OWNER', canManage: false, version: 1,
        createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
      const catalogRows: Record<string, object[]> = {
        '/api/v1/connectors': [], '/api/v1/libraries': [library], '/api/v1/library-files': [],
        [`/api/v1/libraries/${libraryId}/entries`]: [],
      }
      let bootstrapLoads = 0
      let authorizationBegins = 0
      let rememberedRefreshes = 0
      const deviceReports: Record<string, unknown>[] = []
      const feedbackBodies: string[] = []
      const feedbackPayloads: unknown[] = []
      const companyRelease = contentIndex('1.0.0-fixture', [])
      const missingFixtureRoutes: string[] = []
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const path = url.pathname
        response.setHeader('content-type', 'application/json')
        if (path === '/api/v1/dingtalk-auth/authorization-requests' && request.method === 'POST') {
          authorizationBegins++
          response.end(JSON.stringify({ success: true, data: { state: 'fixture-authorization-state',
            authorizationUrl: origin + '/fixture-sign-in' } }))
        } else if (path === '/api/v1/dingtalk-auth/authorization-requests/fixture-authorization-state') {
          response.end(JSON.stringify({ success: true, data: { status: 'completed', session: employeeSession } }))
        } else if (path === '/fixture-sign-in') {
          response.setHeader('content-type', 'text/plain; charset=utf-8')
          response.end('桌面隔离验收登录已完成，可关闭此页面。')
        } else if (path === '/favicon.ico') {
          response.writeHead(204).end()
        } else if (path === '/api/v1/employee-auth/session/refresh') {
          rememberedRefreshes++
          void fixtureRequestBody(request).then((body) => {
            expect(body).toEqual({ refreshToken: refreshSecret })
            response.end(JSON.stringify({ success: true, data: employeeSession }))
          }).catch(() => { response.statusCode = 400; response.end() })
        } else if (path === '/api/v1/company-content') {
          response.end(JSON.stringify({ success: true, data: companyRelease }))
        } else if (path === '/api/v1/bootstrap') {
          bootstrapLoads++
          response.end(JSON.stringify({ success: true, data: { modelApiKey: 'fixture-model-key',
            endpoints: { litellm: model.baseURL + '/v1' }, models: ['deepseek-v4-flash'] } }))
        } else if (path === '/api/v1/device-capabilities' || path === '/api/v1/device-capabilities/presence') {
          void fixtureRequestBody(request).then((body) => {
            deviceReports.push(body)
            if (path.endsWith('/presence')) { response.statusCode = 204; response.end() }
            else response.end(JSON.stringify({ success: true, data: { createdAt: new Date().toISOString() } }))
          }).catch(() => { response.statusCode = 400; response.end() })
        } else if (path === '/api/v1/feedback' && request.method === 'POST') {
          void (async () => {
            const chunks: Buffer[] = []
            for await (const value of request) {
              const chunk: unknown = value
              if (!Buffer.isBuffer(chunk)) throw new Error('Expected feedback bytes')
              chunks.push(Buffer.from(new Uint8Array(chunk)))
            }
            const body = Buffer.concat(chunks)
            feedbackBodies.push(body.toString('utf8'))
            const multipart = await new Response(new Uint8Array(body), {
              headers: { 'content-type': request.headers['content-type'] ?? '' },
            }).formData()
            const feedback = multipart.get('feedback')
            if (!(feedback instanceof File)) throw new Error('Expected feedback metadata')
            feedbackPayloads.push(JSON.parse(await feedback.text()))
            expect(request.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u)
            expect(request.headers.authorization).toBe(`Bearer ${secret}`)
            response.end(JSON.stringify({ success: true, data: { id: 'feedback-fixture' } }))
          })().catch(() => { response.statusCode = 400; response.end() })
        } else if (path === `/api/v1/libraries/${libraryId}`) {
          response.end(JSON.stringify({ success: true, data: library }))
        } else if (path === '/api/v1/libraries/file-policy') {
          response.end(JSON.stringify({ success: true, data: 52428800 }))
        } else if (catalogRows[path] !== undefined) {
          const data = catalogRows[path]
          const pageSize = Number(url.searchParams.get('size') ?? 100)
          response.end(JSON.stringify({ success: true, data, pageIndex: 1, pageSize,
            totalCount: data.length, totalPages: Math.ceil(data.length / pageSize) }))
        } else {
          missingFixtureRoutes.push(`${request.method} ${path}`)
          response.statusCode = 404
          response.end(JSON.stringify({ success: false, errCode: 'FIXTURE_ROUTE_MISSING' }))
        }
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Fixture server has no port')
      const origin = `http://127.0.0.1:${address.port}`
      let app: ElectronApplication | undefined = undefined
      let nativeUpdate: NativeProductUpdateQualification | undefined
      onTestFinished(async () => {
        const closing = app
        app = undefined
        try { if (closing !== undefined) await closeElectronAcceptance(closing) }
        finally {
          try {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((error) => {
              if (error === undefined) resolve()
              else reject(error)
            }))
          } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
        }
      })
      const electronExecutable: unknown = installed ?? createRequire(join(REPO_ROOT, 'apps/desktop/package.json'))('electron')
      if (typeof electronExecutable !== 'string') throw new Error('Electron executable is unavailable')
      if (installed !== undefined) {
        // The installer copy owns this configuration; production endpoints must not receive fixture identities.
        const installationRoot = process.env.DSH_INSTALLED_ROOT
        if (!installationRoot) throw new Error('Installed acceptance requires a private installation root')
        const resources = process.platform === 'darwin' ? resolve(dirname(installed), '../Resources') : join(dirname(installed), 'resources')
        const configPath = join(resources, 'deepseek-harness/product.json')
        if (!(await realpath(configPath)).startsWith(await realpath(installationRoot) + sep)) {
          throw new Error('Installed configuration is outside the private installation root')
        }
        const original = await readFile(configPath, 'utf8')
        onTestFinished(() => writeFile(configPath, original))
        if (['darwin', 'win32'].includes(process.platform) && process.env.PACKAGE_SIGNING === 'internal') {
          nativeUpdate = await prepareNativeProductUpdate({ installed, root, home, userData,
            serverUrl: origin, environment: process.env })
          onTestFinished(() => nativeUpdate!.dispose())
        } else await writeFile(configPath, JSON.stringify({ ...JSON.parse(original), serverUrl: origin }))
      }
      if (installed === undefined) {
        const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8')) as { version: unknown }
        const pnpm = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/node_modules/pnpm/package.json'), 'utf8')) as { version: unknown }
        const release = parseDesktopRelease({ schemaVersion: 1, version: manifest.version,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          nodeVersion: execFileSync(electronExecutable, ['-p', 'process.versions.node'],
            { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim(),
          pnpmVersion: pnpm.version })
        const target = resolveDesktopBuildTarget({}, process.platform, process.arch)
        prepareDevelopmentProject({ projectDir: project, cliDir: join(REPO_ROOT, 'apps/cli'),
          hostDir: join(REPO_ROOT, 'apps/desktop-host'), dependencyDir: join(REPO_ROOT, 'node_modules/.pnpm/node_modules'),
          target, release })
      }
      const profile = join(home, 'profiles/desktop')
      createPluginProfile(profile)
      const assertCompanyInference = () => {
        const saved: unknown = loadOptionalPatches('dsh', join(profile, 'cordis.patch.yml'))
          ?.find(row => row.id === 'agent-default-model')?.config
        expect(z.object({ provider: z.string(), model: z.string() }).parse(saved))
          .toEqual({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
        expect(model.requests.length).toBeGreaterThan(0)
        for (const request of model.requests) {
          expect(request.path).toBe('/v1/messages')
          expect(request.body).toMatchObject({ model: 'deepseek-v4-flash' })
          expect(request.headers['x-api-key']).toBe('fixture-model-key')
          expect(request.headers.authorization).toBeUndefined()
        }
        expect(JSON.stringify(model.requests)).not.toContain(secret)
        expect(JSON.stringify(model.requests)).not.toContain(refreshSecret)
      }
      const hostDiagnostic = join(root, 'host-modules.json')
      const diagnosticPlugin = join(root, 'desktop-module-diagnostics.mjs')
      await copyFile(join(REPO_ROOT, 'apps/product-desktop/tests/fixtures/desktop-module-diagnostics.mjs'), diagnosticPlugin)
      await writeFile(join(profile, 'cordis.patch.yml'),
        '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n'
        + '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false\n'
        + `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(root, 'Documents'))}\n`
        + `- insert:\n  - id: acceptance-module-diagnostics\n    name: ${JSON.stringify(pathToFileURL(diagnosticPlugin).href)}\n    config:\n      output: ${JSON.stringify(hostDiagnostic)}\n`)
      await mkdir(userData)
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('DSH_') && !key.startsWith('DEEPSEEK_') && key !== 'ELECTRON_RUN_AS_NODE'))
      const startupDiagnostic = join(root, 'desktop-startup.txt')
      onTestFinished(async ({ task }) => {
        if (task.result?.state !== 'fail') return
        const diagnostic = await readFile(startupDiagnostic, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
          throw error
        })
        if (diagnostic !== undefined) {
          const safe = diagnostic.replaceAll(secret, '<EMPLOYEE_TOKEN>').replaceAll('fixture-model-key', '<MODEL_KEY>')
          console.error('Desktop startup diagnostic:', safe)
          await mkdir(screenshots, { recursive: true })
          await writeFile(join(screenshots, `electron-${carrier}-${mode}-startup.txt`), safe)
        }
        const modules = await readFile(hostDiagnostic, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
          throw error
        })
        if (modules !== undefined) console.error('Desktop Host module identities:', modules)
      })
      const launchOptions = { executablePath: electronExecutable,
        // A disposable profile must not wait for interactive access to a runner's login keychain.
        args: [`--user-data-dir=${userData}`, ...process.platform === 'darwin' ? ['--use-mock-keychain'] : [],
          ...installed === undefined ? [join(REPO_ROOT, 'apps/desktop')] : []],
        env: { ...environment, DSH_HOME: home,
          DSH_DESKTOP_DIAGNOSTIC_FILE: startupDiagnostic,
          DSH_DESKTOP_OPEN_DEVTOOLS: '0',
          ...installed === undefined ? { DSH_DESKTOP_DSH_DIR: project,
            DSH_DESKTOP_PRIMARY_RUNTIME_DIR: developmentRuntimeDirectory({}, process.platform, process.arch) } : {},
          ...mode === 'official' ? {
            DEEPSEEK_API_KEY: 'fixture-model-key', DEEPSEEK_BASE_URL: model.baseURL + '/v1',
          } : {
            DEEPSEEK_HARNESS_SERVER_URL: origin,
            ...installed === undefined ? { DSH_DESKTOP_EXTENSION: pathToFileURL(join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/lib/index.js')).href } : {},
          },
        }, timeout: 60_000 }
      app = await _electron.launch(launchOptions)
      if (nativeUpdate !== undefined) {
        await app.firstWindow()
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isFocusable()))).toBe(true)
      }
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(installed !== undefined)
      const applicationVersion = await app.evaluate(({ app }) => app.getVersion())
      if (installed !== undefined) {
        const expectedVersion = nativeUpdate?.initialVersion ?? z.string().min(1).parse(process.env.PACKAGE_VERSION)
        expect(applicationVersion, 'Installed application version must match PACKAGE_VERSION').toBe(expectedVersion)
        const appPath = await app.evaluate(({ app }) => app.getAppPath())
        expect(appPath).toContain('app.asar')
        expect(appPath).not.toContain(REPO_ROOT)
      }
      const diagnostics: string[] = []
      const observeShutdown = async (application: ElectronApplication) => {
        const child = application.process()
        child.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString()))
        child.once('exit', (exitCode, signalCode) => diagnostics.push(
          `Acceptance child exit: ${JSON.stringify({ pid: child.pid, exitCode, signalCode })}\n`,
        ))
        child.once('close', (exitCode, signalCode) => diagnostics.push(
          `Acceptance child close: ${JSON.stringify({ pid: child.pid, exitCode, signalCode })}\n`,
        ))
        await application.evaluate(({ app, BrowserWindow }) => {
          let deadline: ReturnType<typeof setTimeout> | undefined
          const report = (phase: string, prevented?: boolean) => {
            // Node's diagnostic handle API is confined to this disposable acceptance process.
            const runtime = process as typeof process & { _getActiveHandles(): Array<{
              constructor: { name: string }
              pid?: number
              exitCode?: number | null
              signalCode?: string | null
              killed?: boolean
              connected?: boolean
              spawnfile?: string
            }> }
            process.stderr.write(`Acceptance shutdown: ${JSON.stringify({
              phase, prevented, pid: process.pid, resources: process.getActiveResourcesInfo(),
              windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible() })),
              children: runtime._getActiveHandles().filter(handle => handle.constructor.name === 'ChildProcess')
                .map(({ pid, exitCode, signalCode, killed, connected, spawnfile }) =>
                  ({ pid, exitCode, signalCode, killed, connected, spawnfile })),
            })}\n`)
          }
          app.on('before-quit', (event) => {
            report('before-quit', event.defaultPrevented)
            if (deadline !== undefined) return
            deadline = setTimeout(() => { report('still-closing') }, 9_000)
            deadline.unref()
          })
          app.on('will-quit', (event) => { report('will-quit', event.defaultPrevented) })
          app.once('quit', () => { clearTimeout(deadline); report('quit') })
        })
      }
      await observeShutdown(app)
      const startupWarnings: string[] = []
      app.context().on('console', (message) => {
        if (message.type() !== 'warning' && message.type() !== 'error') return
        startupWarnings.push(message.text().replaceAll(secret, '<EMPLOYEE_TOKEN>')
          .replaceAll('fixture-model-key', '<MODEL_KEY>'))
      })
      onTestFinished(({ task }) => {
        if (task.result?.state === 'fail') console.error('Desktop process diagnostics:', diagnostics.join(''))
      })
      let page = await app.firstWindow()
      let tripwire = watchConsole(page)
      onTestFinished(async ({ task }) => {
        if (task.result?.state !== 'fail') return
        if (page.isClosed()) {
          console.error('Desktop workflow failure after window closure:', tripwire, startupWarnings)
          return
        }
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `electron-${carrier}-${mode}-failure.png`), timeout: 5000 })
        console.error('Desktop workflow failure:', await page.locator('body').innerText(), tripwire, startupWarnings)
      })
      await page.waitForURL('dsh-app://app/', { timeout: 60_000 })
      await expect.poll(() => readFile(hostDiagnostic, 'utf8').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }), { timeout: 60_000 }).toBeDefined()
      const identities = z.object({ modules: z.array(z.string()), loaderSharesRoot: z.boolean() })
        .parse(JSON.parse(await readFile(hostDiagnostic, 'utf8')))
      expect(identities.loaderSharesRoot).toBe(true)
      expect(identities.modules.filter(url => /\/(?:dsh-)?app-boot\/lib\/index\.js$/u.test(url))).toHaveLength(1)
      for (const entry of [
        /\/(?:product-experts|experts)\/lib\/remote\.js$/u,
        /\/(?:product-experts|experts)\/lib\/index\.js$/u,
        /\/(?:product-skills|skills)\/lib\/index\.js$/u,
      ]) {
        expect(identities.modules.filter(url => entry.test(url)))
          .toHaveLength(mode === 'product' ? 1 : 0)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      let composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.waitFor({ timeout: 60_000 })
      const invoke = async (method: string, payload?: object) => {
        const response = await page.evaluate(({ method, payload }) => {
          const bridge = Reflect.get(globalThis, 'dshDesktop') as DesktopSmokeBridge
          return bridge.extensions.invoke('product', method, payload)
        }, { method, payload }) as { ok: boolean; result?: unknown; failure?: { message: string } }
        if (response.ok) return response.result
        throw Object.assign(new Error(response.failure?.message ?? 'Invalid desktop reply'), response.failure)
      }
      if (mode === 'official') {
        expect(await page.getByRole('button', { name: /^(Expert kits|专家套件)$/, exact: true }).count()).toBe(0)
        await expect(invoke('auth.getSession')).rejects.toThrow()
      } else {
        const navigationSession = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
        await composer.fill('Keep the extension navigation draft')
        for (const [label, content] of [[/^(Expert kits|专家套件)$/, '.aag-library-shell'], [/^(Skills|技能)$/, '.dssm-section']] as const) {
          const entry = page.getByRole('button', { name: label, exact: true })
          await entry.click()
          const capability = page.locator('.product-capability-page')
          await capability.locator(content).waitFor()
          expect(await entry.getAttribute('aria-current')).toBe('page')
          const settings = page.getByRole('dialog', { name: /^(Settings|设置)$/, exact: true })
          expect(await settings.count()).toBe(0)
          await expect.poll(() => capability.innerText()).toMatch(/.+/u)
          expect(await capability.getByRole('alert').count()).toBe(0)
          expect(await capability.evaluate(region => region.scrollWidth > region.clientWidth)).toBe(false)
        }
        await openEmployeeMenu(page)
        await page.getByRole('menuitem', { name: /^(Settings|设置)$/, exact: true }).click()
        const sharedSettings = page.getByRole('dialog', { name: /^(Settings|设置)$/, exact: true })
        await sharedSettings.waitFor()
        for (const section of [/^(Experts|专家)$/, /^(Skills|技能)$/]) {
          expect(await sharedSettings.getByRole('button', { name: section, exact: true }).count()).toBe(0)
        }
        await sharedSettings.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).last().click()
        await sharedSettings.waitFor({ state: 'hidden' })
        await expect.poll(() => page.locator('.product-capability-page .dssm-section').innerText()).toMatch(/.+/u)
        await page.locator(`[data-row-key="session:${navigationSession}"]`).click()
        expect(await composer.textContent()).toBe('Keep the extension navigation draft')
        await expect.poll(() => deviceReports.length).toBeGreaterThan(0)
        expect(JSON.stringify(deviceReports)).not.toContain(secret)
        expect(deviceReports[0]?.deviceId).toMatch(/^[0-9a-f-]{36}$/u)
        expect(deviceReports[0]?.desktopVersion).toBe(applicationVersion)
        await openEmployeeMenu(page)
        expect(await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).count()).toBe(1)
        const signing = z.enum(['signed', 'unsigned', 'internal']).default('unsigned').parse(process.env.PACKAGE_SIGNING)
        if (installed === undefined || signing === 'unsigned') {
          await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).click()
          const updatePage = await dialogWithButton(app, /^(Close|关闭)$/)
          await expect.poll(() => updatePage.title()).toMatch(/^(Update Failed|更新失败)$/u)
          await expect.poll(() => updatePage.locator('#title').textContent()).toMatch(/Could not check for updates\. Please try again later\.|检查更新失败，请稍后重试。/u)
          expect(await updatePage.locator('#technical-details').getAttribute('open')).toBeNull()
          expect(await updatePage.locator('#technical-details-content').isVisible()).toBe(false)
          await updatePage.locator('#technical-details-label').click()
          await expect.poll(() => updatePage.locator('#technical-details-content').innerText()).toMatch(/no packaged update source/u)
          await updatePage.locator('#technical-details-label').click()
          for (const width of [1440, 390]) {
            await updatePage.setViewportSize({ width, height: 900 })
            expect(await updatePage.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
            await updatePage.screenshot({ path: join(screenshots, `electron-${carrier}-product-update-unavailable-${width}.png`), animations: 'disabled' })
          }
          await updatePage.locator('#close').click()
          await expect.poll(() => app!.windows().length).toBe(1)
          const retryUpdate = page.getByRole('button', { name: /^(Retry update|重试更新)$/, exact: true })
          await retryUpdate.waitFor()
          await retryUpdate.click()
          const retriedUpdatePage = await dialogWithButton(app, /^(Close|关闭)$/)
          await expect.poll(() => retriedUpdatePage.title()).toMatch(/^(Update Failed|更新失败)$/u)
          await retriedUpdatePage.locator('#close').click()
          await expect.poll(() => app!.windows().length).toBe(1)
          await openEmployeeMenu(page)
        }
        await page.getByRole('menuitem', { name: /^(Feedback|反馈)$/, exact: true }).click()
        const feedbackDialog = page.getByRole('dialog', { name: /^(Feedback|反馈)$/, exact: true })
        await feedbackDialog.getByLabel(/^(Message|反馈内容)$/, { exact: true }).fill('Desktop support acceptance')
        await feedbackDialog.getByRole('textbox').evaluate((element, bytes) => {
          const clipboardData = new DataTransfer()
          clipboardData.items.add(new File([new Uint8Array(bytes)], 'support-screenshot.png', { type: 'image/png' }))
          element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
        }, [...await page.screenshot()])
        await feedbackDialog.getByRole('img', { name: 'support-screenshot.png', exact: true }).waitFor()
        expect(await feedbackDialog.locator('input[type="file"]').count()).toBe(0)
        expect(await feedbackDialog.getByRole('button', { name: /^(Retry report|重试上报)$/ }).count()).toBe(0)
        expect(await feedbackDialog.locator('div[aria-busy]').evaluate(element => element.querySelector('textarea') !== null
          && element.querySelector('img') !== null)).toBe(true)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          const box = await feedbackDialog.boundingBox()
          expect(box?.x).toBeGreaterThanOrEqual(0)
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width)
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-feedback-${width}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await feedbackDialog.getByRole('button', { name: /^(Submit feedback|提交反馈)$/, exact: true }).click()
        await feedbackDialog.getByText('feedback-fixture', { exact: true }).waitFor()
        expect(feedbackBodies).toHaveLength(1)
        expect(feedbackBodies[0]).toContain('Desktop support acceptance')
        expect(feedbackBodies[0]).toContain('support-screenshot.png')
        expect(feedbackBodies[0]).toContain('image/png')
        expect(feedbackBodies[0]).not.toContain(secret)
        expect(feedbackPayloads).toEqual([{ message: 'Desktop support acceptance', category: 'BUG',
          desktopVersion: applicationVersion, deviceId: deviceReports[0]?.deviceId, taskId: '' }])
        expect(await feedbackDialog.getByRole('img').count()).toBe(0)
        await feedbackDialog.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).last().click()
        if (surface === 'support') {
          expect(tripwire.pageErrors).toEqual([])
          return
        }
        await composer.fill('Review the product desktop')
        await composer.press('Enter')
        await page.locator('p').filter({ hasText: /^Fixture review complete\.$/ }).waitFor()
        await expect.poll(() => page.locator('[data-chat-running]').count()).toBe(0)
        assertCompanyInference()
        const sessionId = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
        await composer.fill('Keep this task draft')
        for (const name of [/^(Connectors|连接器)$/, /^(Libraries|资料库)$/]) {
          await page.getByRole('button', { name, exact: true }).click()
          const directory = page.getByRole('region', { name, exact: true }).first()
          await directory.getByRole('searchbox').waitFor()
          expect(await directory.getByRole('alert').count()).toBe(0)
        }
        await page.locator('[data-library-root]').getByText('Operations playbook', { exact: true }).click()
        await page.locator('[data-library-root][aria-current="page"]').waitFor()
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          for (const width of [1440, 390]) {
            if (width === 390) {
              const collapse = page.getByRole('button', { name: /^(Collapse sidebar|收起侧边栏)$/, exact: true })
              if (await collapse.count()) await collapse.click()
              await page.locator('[data-sidebar-collapsed]').waitFor({ state: 'attached' })
            }
            await page.setViewportSize({ width, height: 900 })
            await page.getByRole('searchbox').click({ trial: true })
            expect(await page.getByRole('region', { name: /^(Libraries|资料库)$/, exact: true }).first().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
            await mkdir(screenshots, { recursive: true })
            await page.screenshot({ path: join(screenshots, `electron-${carrier}-library-${theme}-${width}.png`) })
          }
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
        await page.locator(process.platform === 'darwin' ? '[data-sidebar-opener]' : '[data-sidebar-toggle]').first().click()
        const retainedSession = page.locator(`[data-row-key="session:${sessionId}"]`)
        await retainedSession.focus()
        await retainedSession.press('Enter')
        expect(await composer.textContent()).toBe('Keep this task draft')
        await expect.poll(() => page.evaluate(id => localStorage.getItem(`dsh.conversation.${id}`), sessionId)).toContain('Keep this task draft')
        const closing = app
        app = undefined
        await closeElectronAcceptance(closing)
        app = await _electron.launch(launchOptions)
        await observeShutdown(app)
        page = await app.firstWindow()
        tripwire = watchConsole(page)
        await page.waitForURL('dsh-app://app/', { timeout: 60_000 })
        composer = page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.waitFor({ timeout: 60_000 })
        expect(authorizationBegins).toBe(1)
        expect(rememberedRefreshes).toBeGreaterThan(0)
        const storedLogin = await readFile(join(userData, 'deepseek-harness-session.json'), 'utf8')
        expect(storedLogin).not.toContain(secret)
        expect(storedLogin).not.toContain(refreshSecret)
        await page.locator(`[data-row-key="session:${sessionId}"]`).click()
        await expect.poll(() => composer.textContent()).toBe('Keep this task draft')
        await page.locator('p').filter({ hasText: /^Fixture review complete\.$/ }).waitFor()
        await page.getByRole('button', { name: /^(New session|新建会话)$/, exact: true }).last().click()
      }
      expect(missingFixtureRoutes).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      if (nativeUpdate !== undefined) {
        if (app === undefined) throw new Error('Native update qualification has no application owner')
        const previousBootstrapLoads = bootstrapLoads
        page = await nativeUpdate.upgrade(app, page, () => { app = undefined })
        expect(bootstrapLoads).toBeGreaterThan(previousBootstrapLoads)
        assertCompanyInference()
      }
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `electron-${carrier}-${mode}.png`) })
    },
  )
}
