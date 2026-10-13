/** Plain Node packaging checks start an Electron Host inside a real ASAR archive. */
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { realpathSync, type WriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: object) => Promise<WriteStream>
}

it.each([false, true])('shares archived startup and profile modules through aliases (preserve symlinks: %s)', { retry: 0 }, async (preserveSymlinks) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-archived-host-'))
  let alias: string | undefined
  let host: DesktopHostProcess | undefined
  try {
    const source = join(root, 'source')
    const packageRoot = join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
    const sharedRoot = join(source, 'dsh', 'node_modules', '@fixture', 'shared')
    const addonRoot = join(source, 'dsh', 'node_modules', 'node-addon-require-builtin')
    const profile = join(root, 'profiles', 'desktop')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await mkdir(sharedRoot, { recursive: true })
    await mkdir(addonRoot, { recursive: true })
    await mkdir(profile, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(sharedRoot, 'package.json'), '{"name":"@fixture/shared","type":"module","exports":"./index.js"}\n')
    await writeFile(join(sharedRoot, 'index.js'), 'export const identity = Symbol(); export const url = import.meta.url\n')
    // --expose-internals supplies the built resolver's private adapter without loading a native addon fixture.
    await writeFile(join(addonRoot, 'index.js'), 'exports.requireBuiltin = require\n')
    await writeFile(join(source, 'dsh', 'worker-bootstrap.mjs'), await readFile(
      new URL('../../../packages/boot/app-boot/lib/worker/profile-resolution-bootstrap.js', import.meta.url),
    ))
    await writeFile(join(profile, 'entry.mjs'), 'export * from "@fixture/shared"\n')
    await writeFile(join(packageRoot, 'lib', 'index.js'), `
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setEnvironmentData } from 'node:worker_threads'
import * as shared from '@fixture/shared'
const profile = process.argv[3]
const aliasRuntime = join(profile, '..', '..', 'app.asar', 'dsh')
setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', { resolution: {
  profilesDir: join(profile, '..'), profileDir: profile, localPackageNames: [], linkedRoots: [],
  entries: [{ name: '@fixture/shared', scope: 'installation',
    packageDir: join(aliasRuntime, 'node_modules', '@fixture', 'shared'),
    declarer: join(aliasRuntime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json') }],
} })
await import(pathToFileURL(join(process.argv[2], 'worker-bootstrap.mjs')).href)
const selected = await import(pathToFileURL(join(profile, 'entry.mjs')).href)
const queryUrl = pathToFileURL(join(aliasRuntime, 'node_modules', '@fixture', 'shared', 'index.js'))
queryUrl.search = '?revision=1'
queryUrl.hash = '#fixture'
const revision = await import(queryUrl.href)
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ entry: import.meta.url, runtime: process.argv[2], main: import.meta.main,
    sharedIdentity: shared.identity === selected.identity, sharedUrl: selected.url,
    sharedCanonicalUrl: pathToFileURL(realpathSync.native(join(aliasRuntime, 'node_modules', '@fixture', 'shared', 'index.js'))).href,
    revisionUrl: revision.url, revisionIdentity: shared.identity !== revision.identity }))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/' })
})
process.on('message', message => {
  if (message.type !== 'shutdown') return
  server.close(() => process.send({ type: 'shutdown-complete' }, () => process.disconnect()))
  server.closeAllConnections()
})
`)
    const archive = join(root, 'app.asar')
    await finished(await createPackageWithOptions(source, archive, {}), { cleanup: true })
    const aliasPath = join(root, 'Archive Alias')
    await symlink(root, aliasPath, process.platform === 'win32' ? 'junction' : 'dir')
    alias = aliasPath
    host = new DesktopHostProcess(require('electron') as string, join(alias, 'app.asar', 'dsh'), profile,
      undefined, { ...process.env, ...(preserveSymlinks ? { NODE_OPTIONS: '--preserve-symlinks' } : {}) })
    const { url } = await host.start()
    const canonical = join(realpathSync.native(archive), 'dsh')
    expect(await (await fetch(url)).json()).toEqual({
      runtime: canonical,
      entry: pathToFileURL(join(canonical, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')).href,
      main: true,
      sharedIdentity: true,
      sharedUrl: pathToFileURL(join(canonical, 'node_modules', '@fixture', 'shared', 'index.js')).href,
      sharedCanonicalUrl: pathToFileURL(join(canonical, 'node_modules', '@fixture', 'shared', 'index.js')).href,
      revisionUrl: pathToFileURL(join(canonical, 'node_modules', '@fixture', 'shared', 'index.js')).href + '?revision=1#fixture',
      revisionIdentity: true,
    })
  } finally {
    await host?.stop()
    if (alias !== undefined) await unlink(alias)
    await rm(root, { recursive: true, force: true })
  }
})
