/** Plain Node packaging checks start an Electron Host inside a real ASAR archive. */
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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

it('starts an archived Host from plain Node through a directory alias', { retry: 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-archived-host-'))
  let alias: string | undefined
  let host: DesktopHostProcess | undefined
  try {
    const source = join(root, 'source')
    const packageRoot = join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(packageRoot, 'lib', 'index.js'), `
import { createServer } from 'node:http'
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ entry: import.meta.url, runtime: process.argv[2] }))
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
    host = new DesktopHostProcess(require('electron') as string, join(alias, 'app.asar', 'dsh'), root)
    const { url } = await host.start()
    const canonical = join(realpathSync.native(archive), 'dsh')
    expect(await (await fetch(url)).json()).toEqual({
      runtime: canonical,
      entry: pathToFileURL(join(canonical, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')).href,
    })
  } finally {
    await host?.stop()
    if (alias !== undefined) await unlink(alias)
    await rm(root, { recursive: true, force: true })
  }
})
