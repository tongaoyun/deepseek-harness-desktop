/** Real product application qualification through Squirrel.Mac or the production NSIS installer; only identity and network services use fixtures. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { verifyRuntimeArchive } from '../../desktop/scripts/verify-runtime-archive.ts'
import { createElectronBuilderConfig } from '../../desktop/scripts/electron-builder-config.mjs'
import { rewriteWindowsArchiveIntegrity, writeUpdateArchive } from './native-update-integrity.mjs'
import { stopInstalledProcesses } from '../scripts/installed-processes.mjs'
import { INTERNAL_APP_ID, resignInternalApplicationResources, verifyInternalApplication } from '../scripts/internal-package.mjs'
import { originalWindowsProcesses, windowsProcessDescendants, windowsProcessSnapshot } from './windows-processes.mjs'

const run = promisify(execFile)
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
const builder = createRequire(require.resolve('electron-builder'))
const packager = createRequire(builder.resolve('app-builder-lib'))
const asar = packager('@electron/asar')
const windows = process.platform === 'win32'

/** Explicit restart authorization, with or without active tasks. */
export const restartConfirmation = /^(Install and Restart|安装并重启|Stop tasks and update|停止任务并更新)$/

async function descendants(parent) {
  if (windows) {
    return windowsProcessDescendants(await windowsProcessSnapshot(), parent)
  }
  const rows = (await run('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout.trim().split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
    .filter(Boolean).map(row => ({ pid: Number(row[1]), parent: Number(row[2]), command: row[3] }))
  const result = []
  const pending = [parent]
  for (const pid of pending) for (const row of rows) {
    if (row.parent === pid) { result.push(row); pending.push(row.pid) }
  }
  return result
}

/**
 * Select only the shell-owned confirmation, even when the product status has the same action label.
 * @param application Native window owner.
 * @param name Expected confirmation button.
 * @param timeout Bounded dialog readiness wait.
 * @returns Matching update-dialog document.
 */
export async function dialogWithButton(application, name, timeout = 120_000) {
  let matching
  const observations = []
  try {
    await expect.poll(async () => {
      for (const page of application.windows()) {
        if (page.isClosed() || page.url() !== 'dsh-app://shell/update-dialog.html') continue
        const buttons = await page.getByRole('button').allTextContents()
          .catch(error => { if (page.isClosed()) return []; throw error })
        const key = JSON.stringify(buttons)
        if (observations.at(-1) !== key) { observations.push(key); console.log('Native update confirmation buttons:', key) }
        const visible = await page.getByRole('button', { name, exact: true }).isVisible()
          .catch(error => { if (page.isClosed()) return false; throw error })
        if (visible) { matching = page; return true }
      }
      return false
    }, { timeout }).toBe(true)
  } catch (error) {
    throw new Error(`Native update confirmation ${name} was not available; observed buttons: ${observations.join(' → ')}; documents: ${application.windows().map(page => page.url()).join(', ')}`, { cause: error })
  }
  return matching
}

async function rewriteApplication(appPath, version, bootstrap) {
  const resources = join(appPath, windows ? 'resources' : 'Contents/Resources')
  const archive = join(resources, 'app.asar')
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'))
  const entry = manifest.main
  manifest.version = version
  manifest.main = 'internal-update-qualification.mjs'
  const replacements = new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest))],
    ['internal-update-qualification.mjs', Buffer.from(bootstrap + `\nawait import(${JSON.stringify('./' + entry)})\n`)],
  ])
  const next = join(resources, 'qualified.asar')
  await writeUpdateArchive(archive, next, replacements)
  asar.uncache(archive)
  await rm(archive)
  await rm(archive + '.unpacked', { recursive: true, force: true })
  await rename(next, archive)
  await rename(next + '.unpacked', archive + '.unpacked')
  await verifyRuntimeArchive(archive, JSON.parse(asar.extractFile(archive, join('dsh', 'desktop-runtime.json'))))
  if (windows) {
    await rewriteWindowsArchiveIntegrity(join(appPath, 'DeepSeek Harness.exe'),
      createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex'))
    return
  }
  const plist = join(appPath, 'Contents/Info.plist')
  const info = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', plist])).stdout)
  const integrity = info.ElectronAsarIntegrity
  if (!integrity?.['Resources/app.asar']) throw new Error('Product application has no ASAR integrity metadata')
  integrity['Resources/app.asar'].hash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex')
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) await run('plutil', ['-replace', key, '-string', version, plist])
  await run('plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify(integrity), plist])
}

/**
 * Verify the unmodified installation, then prepare private versions with qualification bootstrap and fixture services.
 * @param {object} options Private installation, fixture services, data paths and platform signing settings.
 * @returns {Promise<object>} UI upgrade operation and owned fixture cleanup.
 */
export async function prepareNativeProductUpdate(options) {
  const { installed, root, home, userData, serverUrl, modelUrl, token, environment } = options
  const appPath = windows ? dirname(installed) : resolve(dirname(installed), '../..')
  if (!windows) await verifyInternalApplication(appPath, environment)
  const directory = join(root, 'native-update')
  await mkdir(directory)
  const nextApp = join(directory, 'next', windows ? 'DeepSeek Harness' : 'DeepSeek Harness.app')
  await mkdir(dirname(nextApp))
  if (windows) await cp(appPath, nextApp, { recursive: true })
  else await run('/bin/cp', ['-cR', appPath, nextApp])
  const current = JSON.parse(asar.extractFile(join(appPath, windows ? 'resources/app.asar' : 'Contents/Resources/app.asar'), 'package.json'))
  const version = current.version
  assert.equal(version, environment.PACKAGE_VERSION, 'Installed update payload must match the requested build version')
  const initialVersion = version.replace(/\.\d{8}\.\d+\.\d+$/u, '.20000101.1.1')
  assert.notEqual(initialVersion, version)
  const stop = join(directory, 'stop')
  const bootstrap = `import { app } from 'electron'
import { watch, writeFileSync } from 'node:fs'
process.env.DSH_HOME = ${JSON.stringify(home)}
process.env.DSH_DESKTOP_USER_DATA_DIR = ${JSON.stringify(userData)}
process.env.DEEPSEEK_BASE_URL = ${JSON.stringify(modelUrl)}
process.env.DEEPSEEK_API_KEY = 'fixture-model-key'
process.env.DEEPSEEK_HARNESS_SESSION_TOKEN = ${JSON.stringify(token)}
process.env.DSH_TELEMETRY_DISABLED = '1'
app.setPath('userData', ${JSON.stringify(userData)})
app.commandLine.appendSwitch('use-mock-keychain')
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.on('browser-window-created', (_event, window) => window.setFocusable(false))
const watcher = watch(${JSON.stringify(directory)}, (event, file) => { if (file === 'stop') app.quit() })
app.on('will-quit', () => watcher.close())
app.whenReady().then(() => writeFileSync(${JSON.stringify(directory)} + '/boot-' + app.getVersion() + '.json', JSON.stringify({pid:process.pid,version:app.getVersion()})))
`
  const zipName = `update-${process.arch}.${windows ? 'exe' : 'zip'}`
  const zip = join(directory, zipName)
  let metadata
  let browser
  let initialPid
  let updatedPid
  let initialWindowsProcess
  let updatedWindowsProcess
  const requests = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    requests.push(path)
    if (path === (windows ? '/nightly.yml' : '/nightly-mac.yml') && metadata) { response.end(JSON.stringify(metadata)); return }
    if (path === '/' + zipName) { createReadStream(zip).pipe(response); return }
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}/`
  let cache
  try {
    console.log('Native product update: preparing private versions and integrity records')
    cache = await mkdtemp(join(windows ? environment.LOCALAPPDATA ?? join(homedir(), 'AppData/Local') : join(homedir(), 'Library/Caches'), 'harness-qualification-'))
    for (const [application, selected] of [[appPath, initialVersion], [nextApp, version]]) {
      await rewriteApplication(application, selected, bootstrap)
      const configPath = join(application, windows ? 'resources' : 'Contents/Resources', 'deepseek-harness/product.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      await writeFile(configPath, JSON.stringify({ ...config, serverUrl }))
      await writeFile(join(application, windows ? 'resources/app-update.yml' : 'Contents/Resources/app-update.yml'), JSON.stringify({
        provider: 'generic', url: origin, channel: 'nightly', updaterCacheDirName: basename(cache),
      }))
      if (!windows) await resignInternalApplicationResources(application, environment)
    }
    if (windows) {
      console.log('Native product update: packaging the next version with the production NSIS installer')
      const { build, Platform, Arch } = require('electron-builder')
      const project = join(directory, 'packaging')
      await mkdir(project)
      await writeFile(join(project, 'package.json'), JSON.stringify({ ...current, version }))
      const config = createElectronBuilderConfig({ ...environment, DSH_DESKTOP_UNSIGNED: '1',
        DSH_DESKTOP_BUILD_VERSION: version, DSH_DESKTOP_APP_ID: INTERNAL_APP_ID }, 'win32', 'x64')
      // Use the shipped directory-staging NSIS adapter, resources and install identity for an already assembled product.
      await build({ projectDir: project, prepackaged: nextApp, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never',
        config: { appId: INTERNAL_APP_ID, productName: config.productName, electronVersion: require('electron/package.json').version,
          directories: { output: directory }, artifactName: zipName, nsis: config.nsis,
          win: { ...config.win, signAndEditExecutable: false }, compression: 'normal',
          detectUpdateChannel: false, publish: [{ provider: 'generic', url: origin, channel: 'nightly' }] } })
    } else {
      console.log('Native product update: archiving the signed next version')
      await run('/usr/bin/ditto', ['-c', '-k', '--zlibCompressionLevel', '1', '--sequesterRsrc', '--keepParent', nextApp, zip], { timeout: 120_000 })
    }
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of createReadStream(zip)) { hash.update(chunk); size += chunk.length }
    const sha512 = hash.digest('base64')
    metadata = { version, path: zipName, sha512, files: [{ url: zipName, sha512, size }] }
    console.log('Native product update: private update feed is ready')
  } catch (error) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (cache) await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw error
  }
  const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  return {
    initialVersion,
    async upgrade(application, page, releaseOwnership) {
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      // The catalog scenario ends on a disposable empty task; retain a task with actual history.
      const existing = page.locator('[data-row-key^="session:"]:not([aria-selected="true"])').first()
      const key = await existing.getAttribute('data-row-key')
      assert.ok(key?.startsWith('session:'))
      await page.locator(`[data-row-key="${key}"]`).click()
      await expect.poll(() => page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')).toBe(key.slice('session:'.length))
      const session = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
      const draft = `Native update retained draft ${randomUUID()}`
      await composer.fill(draft)
      await page.getByRole('button', { name: /^(New session|新建会话)$/, exact: true }).last().click()
      await expect.poll(() => page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')).not.toBe(session)
      await page.locator(`[data-row-key="session:${session}"]`).click()
      await expect.poll(() => composer.textContent()).toBe(draft)
      console.log('Native product update: downloading the prepared next version')
      await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
      await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).click()
      const install = await dialogWithButton(application, restartConfirmation)
      assert.ok(requests.includes('/' + zipName), 'Product update action must download the next version before restart confirmation')
      await install.locator('#close').click()
      assert.equal(await application.evaluate(({ app }) => app.getVersion()), initialVersion)
      await expect.poll(() => composer.textContent()).toBe(draft)
      console.log('Native product update: cancelled restart retained the old version and draft')
      await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
      await expect.poll(() => application.windows().length).toBe(1)
      await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).click()
      const ready = await dialogWithButton(application, restartConfirmation)
      const oldPid = application.process().pid
      initialPid = oldPid
      const previousSnapshot = windows ? await windowsProcessSnapshot() : undefined
      initialWindowsProcess = previousSnapshot?.find(process => process.pid === oldPid)
      const previousChildren = windows ? windowsProcessDescendants(previousSnapshot, oldPid) : await descendants(oldPid)
      const host = previousChildren.find(child => (child.command ?? '').replaceAll('\\', '/').includes('/dsh-desktop-host/'))
      const sidecar = previousChildren.find(child => (child.command ?? '').replaceAll('\\', '/').includes('/deepseek-harness-native'))
      assert.ok(host, 'Product Host must be running before update')
      assert.ok(sidecar, 'Product native sidecar must be running before update')
      const exited = new Promise(resolve => application.process().once('exit', resolve))
      const debuggingPort = join(userData, 'DevToolsActivePort')
      await rm(debuggingPort)
      releaseOwnership()
      await ready.getByRole('button', { name: restartConfirmation, exact: true }).click()
      await exited
      console.log('Native product update: old process exited; waiting for native restart')
      const bootFile = join(directory, `boot-${version}.json`)
      await expect.poll(() => readFile(bootFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), { timeout: 120_000 }).not.toBe('')
      updatedPid = JSON.parse(await readFile(bootFile, 'utf8')).pid
      if (windows) {
        const originals = [initialWindowsProcess, ...previousChildren]
        const current = await windowsProcessSnapshot()
        updatedWindowsProcess = current.find(process => process.pid === updatedPid)
        assert.ok(updatedWindowsProcess, 'Native restart must launch an observable process')
        assert.ok(updatedPid !== oldPid || updatedWindowsProcess.started !== initialWindowsProcess.started,
          'Native restart must launch a different process instance')
        let observed = current
        try {
          await expect.poll(async () => {
            observed = await windowsProcessSnapshot()
            return originalWindowsProcesses(observed, originals)
          }, { timeout: 20_000 }).toEqual([])
        } catch (error) {
          const describe = ({ pid, parent, started, image }) => ({ pid, parent, started, image })
          const detail = { previous: originals.map(describe), current: observed.filter(process => originals.some(original => original.pid === process.pid)).map(describe) }
          const evidence = resolve(import.meta.dirname, '../../../.artifacts')
          await mkdir(evidence, { recursive: true })
          await writeFile(join(evidence, `native-windows-update-${process.arch}-processes.json`), JSON.stringify(detail, null, 2) + '\n')
          console.error('Native update process identities:', JSON.stringify(detail))
          throw error
        }
      } else {
        assert.notEqual(updatedPid, oldPid)
        assert.equal(alive(oldPid), false)
        await expect.poll(() => previousChildren.filter(child => alive(child.pid)).map(child => child.pid), { timeout: 20_000 }).toEqual([])
      }
      await expect.poll(() => readFile(debuggingPort, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), { timeout: 60_000 }).not.toBe('')
      const port = (await readFile(debuggingPort, 'utf8')).split('\n')[0]
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      await expect.poll(() => browser.contexts()[0].pages().some(window => window.url() === 'dsh-app://app/'), { timeout: 60_000 }).toBe(true)
      const updated = browser.contexts()[0].pages().find(window => window.url() === 'dsh-app://app/')
      assert.ok(updated)
      await expect.poll(() => updated.locator('[data-conversation-session]').last().getAttribute('data-conversation-session'), { timeout: 60_000 }).toBe(session)
      await expect.poll(() => updated.locator('[data-composer-input][contenteditable="true"]').last().textContent()).toBe(draft)
      const updatedArchive = join(appPath, windows ? 'resources/app.asar' : 'Contents/Resources/app.asar')
      asar.uncache(updatedArchive)
      assert.equal(JSON.parse(asar.extractFile(updatedArchive, 'package.json')).version, version)
      if (!windows) await verifyInternalApplication(appPath, environment)
      const evidence = resolve(import.meta.dirname, '../../../.artifacts')
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `native-${windows ? 'windows' : 'macos'}-update-${process.arch}.json`), JSON.stringify({ passed: true, from: initialVersion, to: version,
        nativeInstaller: windows ? 'NSIS' : 'Squirrel.Mac', deferredRestartRetainedVersion: true, sessionAndDraftRetained: true,
        oldProcessExited: true, hostExited: host.pid, sidecarExited: sidecar.pid,
        oldChildProcessesExited: previousChildren.map(child => child.pid),
        ...(windows ? { oldProcessIdentities: [initialWindowsProcess, ...previousChildren]
          .map(({ pid, parent, started, image }) => ({ pid, parent, started, image })) } : {}) }) + '\n')
      console.log('Native product update passed:', initialVersion, '→', version)
      return updated
    },
    async dispose() {
      try {
        if (!updatedPid) {
          const boot = await readFile(join(directory, `boot-${version}.json`), 'utf8')
            .catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
          if (boot) updatedPid = JSON.parse(boot).pid
        }
        if (windows) {
          if (initialPid || updatedPid) {
            const originals = [initialWindowsProcess, updatedWindowsProcess].filter(Boolean)
            await writeFile(stop, '')
            try {
              await expect.poll(async () => originalWindowsProcesses(await windowsProcessSnapshot(), originals), { timeout: 20_000 }).toEqual([])
            } finally { stopInstalledProcesses(appPath) }
          }
        } else {
          const running = [initialPid, updatedPid].filter(pid => pid && alive(pid))
          if (running.length) {
            const owned = (await Promise.all(running.map(descendants))).flat()
            await writeFile(stop, '')
            try { await expect.poll(() => running.filter(alive), { timeout: 20_000 }).toEqual([]) }
            finally {
              for (const pid of [...owned.map(child => child.pid).reverse(), ...running]) {
                if (alive(pid)) process.kill(pid, 'SIGKILL')
              }
              await expect.poll(() => [...running, ...owned.map(child => child.pid)].filter(alive), { timeout: 10_000 }).toEqual([])
            }
          }
        }
        if (browser) await browser.close()
      } finally {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
        await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    },
  }
}
