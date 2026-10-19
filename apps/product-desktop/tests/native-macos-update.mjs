/** Real product application qualification through Squirrel.Mac; only identity and network services use fixtures. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { verifyRuntimeArchive } from '../../desktop/scripts/verify-runtime-archive.ts'
import { signInternalApplication, verifyInternalApplication } from '../scripts/internal-package.mjs'

const run = promisify(execFile)
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
const builder = createRequire(require.resolve('electron-builder'))
const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar')

async function descendants(parent) {
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

async function dialogWithButton(application, name, timeout = 120_000) {
  let matching
  await expect.poll(async () => {
    for (const page of application.windows()) {
      if (page.isClosed()) continue
      const visible = await page.getByRole('button', { name, exact: true }).isVisible()
        .catch(error => { if (page.isClosed()) return false; throw error })
      if (visible) { matching = page; return true }
    }
    return false
  }, { timeout }).toBe(true)
  return matching
}

async function rewriteApplication(appPath, version, bootstrap) {
  const resources = join(appPath, 'Contents/Resources')
  const archive = join(resources, 'app.asar')
  const original = asar.getRawHeader(archive).header
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'))
  const entry = manifest.main
  manifest.version = version
  manifest.main = 'internal-update-qualification.mjs'
  const replacements = new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest))],
    ['internal-update-qualification.mjs', Buffer.from(bootstrap + `\nawait import(${JSON.stringify('./' + entry)})\n`)],
  ])
  const streams = []
  const add = (path, node, inherited = false) => {
    const unpacked = inherited || node.unpacked === true
    if (node.files) {
      if (path) streams.push({ path, type: 'directory', unpacked })
      for (const [name, child] of Object.entries(node.files)) add(path ? `${path}/${name}` : name, child, unpacked)
    } else if (node.link) {
      streams.push({ path, type: 'link', unpacked, stat: { mode: 0o777 }, symlink: posix.relative(posix.dirname(path), node.link) })
    } else {
      const bytes = replacements.get(path)
      const mode = unpacked ? statSync(join(archive + '.unpacked', path)).mode : node.executable ? 0o755 : 0o644
      streams.push({ path, type: 'file', unpacked, stat: { mode, size: bytes?.length ?? node.size },
        streamGenerator: () => Readable.from([bytes ?? asar.extractFile(archive, path)]) })
    }
  }
  add('', original)
  const boot = replacements.get('internal-update-qualification.mjs')
  streams.push({ path: 'internal-update-qualification.mjs', type: 'file', unpacked: false,
    stat: { mode: 0o644, size: boot.length }, streamGenerator: () => Readable.from([boot]) })
  const next = join(resources, 'qualified.asar')
  await asar.createPackageFromStreams(next, streams)
  asar.uncache(archive)
  await rm(archive)
  await rm(archive + '.unpacked', { recursive: true, force: true })
  await rename(next, archive)
  await rename(next + '.unpacked', archive + '.unpacked')
  await verifyRuntimeArchive(archive, JSON.parse(asar.extractFile(archive, 'dsh/desktop-runtime.json')))
  const plist = join(appPath, 'Contents/Info.plist')
  const info = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', plist])).stdout)
  const integrity = info.ElectronAsarIntegrity
  if (!integrity?.['Resources/app.asar']) throw new Error('Product application has no ASAR integrity metadata')
  integrity['Resources/app.asar'].hash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex')
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) await run('plutil', ['-replace', key, '-string', version, plist])
  await run('plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify(integrity), plist])
}

/**
 * Prepare two private copies of the actual product, preserving all original files except qualification bootstrap and versions.
 * @param {object} options Private installation, fixture services, data paths and imported fixed certificate.
 * @returns {Promise<object>} UI upgrade operation and owned fixture cleanup.
 */
export async function prepareNativeMacUpdate(options) {
  const { installed, root, home, userData, modelUrl, token, environment } = options
  const appPath = resolve(dirname(installed), '../..')
  const directory = join(root, 'native-update')
  await mkdir(directory)
  const nextApp = join(directory, 'next', 'DeepSeek Harness.app')
  await mkdir(dirname(nextApp))
  await run('/bin/cp', ['-cR', appPath, nextApp])
  const current = JSON.parse(asar.extractFile(join(appPath, 'Contents/Resources/app.asar'), 'package.json'))
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
const watcher = watch(${JSON.stringify(directory)}, (event, file) => { if (file === 'stop') app.quit() })
app.on('will-quit', () => watcher.close())
app.whenReady().then(() => writeFileSync(${JSON.stringify(directory)} + '/boot-' + app.getVersion() + '.json', JSON.stringify({pid:process.pid,version:app.getVersion()})))
`
  const zipName = `update-${process.arch}.zip`
  const zip = join(directory, zipName)
  let metadata
  let browser
  let initialPid
  let updatedPid
  const requests = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    requests.push(path)
    if (path === '/nightly-mac.yml' && metadata) { response.end(JSON.stringify(metadata)); return }
    if (path === '/' + zipName) { createReadStream(zip).pipe(response); return }
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}/`
  try {
    for (const [application, selected] of [[appPath, initialVersion], [nextApp, version]]) {
      await rewriteApplication(application, selected, bootstrap)
      await writeFile(join(application, 'Contents/Resources/app-update.yml'), JSON.stringify({
        provider: 'generic', url: origin, channel: 'nightly', updaterCacheDirName: `harness-qualification-${randomUUID()}`,
      }))
      await signInternalApplication(application, environment)
    }
    await run('/usr/bin/ditto', ['-c', '-k', '--zlibCompressionLevel', '1', '--sequesterRsrc', '--keepParent', nextApp, zip], { timeout: 120_000 })
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of createReadStream(zip)) { hash.update(chunk); size += chunk.length }
    metadata = { version, files: [{ url: zipName, sha512: hash.digest('base64'), size }] }
  } catch (error) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
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
      const dialog = await dialogWithButton(application, /^(Download update|下载更新)$/)
      await dialog.getByRole('button', { name: /^(Download update|下载更新)$/, exact: true }).click()
      const install = await dialogWithButton(application, /^(Install and Restart|安装并重启)$/)
      await install.locator('#close').click()
      assert.equal(await application.evaluate(({ app }) => app.getVersion()), initialVersion)
      await expect.poll(() => composer.textContent()).toBe(draft)
      console.log('Native product update: cancelled restart retained the old version and draft')
      await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
      await expect.poll(() => application.windows().length).toBe(1)
      await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).click()
      const ready = await dialogWithButton(application, /^(Install and Restart|安装并重启)$/)
      const oldPid = application.process().pid
      initialPid = oldPid
      const previousChildren = await descendants(oldPid)
      const host = previousChildren.find(child => child.command.includes('/dsh-desktop-host/'))
      const sidecar = previousChildren.find(child => child.command.includes('/deepseek-harness-native'))
      assert.ok(host, 'Product Host must be running before update')
      assert.ok(sidecar, 'Product native sidecar must be running before update')
      const exited = new Promise(resolve => application.process().once('exit', resolve))
      const debuggingPort = join(userData, 'DevToolsActivePort')
      await rm(debuggingPort)
      releaseOwnership()
      await ready.getByRole('button', { name: /^(Install and Restart|安装并重启)$/, exact: true }).click()
      await exited
      console.log('Native product update: old process exited; waiting for native restart')
      const bootFile = join(directory, `boot-${version}.json`)
      await expect.poll(() => readFile(bootFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), { timeout: 120_000 }).not.toBe('')
      updatedPid = JSON.parse(await readFile(bootFile, 'utf8')).pid
      assert.notEqual(updatedPid, oldPid)
      assert.equal(alive(oldPid), false)
      await expect.poll(() => previousChildren.filter(child => alive(child.pid)).map(child => child.pid), { timeout: 20_000 }).toEqual([])
      await expect.poll(() => readFile(debuggingPort, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), { timeout: 60_000 }).not.toBe('')
      const port = (await readFile(debuggingPort, 'utf8')).split('\n')[0]
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      await expect.poll(() => browser.contexts()[0].pages().some(window => window.url() === 'dsh-app://app/'), { timeout: 60_000 }).toBe(true)
      const updated = browser.contexts()[0].pages().find(window => window.url() === 'dsh-app://app/')
      assert.ok(updated)
      await expect.poll(() => updated.locator('[data-conversation-session]').last().getAttribute('data-conversation-session'), { timeout: 60_000 }).toBe(session)
      await expect.poll(() => updated.locator('[data-composer-input][contenteditable="true"]').last().textContent()).toBe(draft)
      await verifyInternalApplication(appPath, environment)
      assert.ok(requests.includes('/' + zipName))
      const evidence = resolve(import.meta.dirname, '../../../.artifacts')
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `native-macos-update-${process.arch}.json`), JSON.stringify({ passed: true, from: initialVersion, to: version,
        nativeInstaller: 'Squirrel.Mac', deferredRestartRetainedVersion: true, sessionAndDraftRetained: true,
        oldProcessExited: true, hostExited: host.pid, sidecarExited: sidecar.pid,
        oldChildProcessesExited: previousChildren.map(child => child.pid) }) + '\n')
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
        if (browser) await browser.close()
      } finally {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
    },
  }
}
