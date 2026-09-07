// Asset conversion only: reads the reference app without modifying it.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const resources = process.argv[2] ?? '/Applications/QoderWork CN.app/Contents/Resources'
const original = join(resources, 'icon.icns')
const tray = join(resources, 'trayTemplate@2x.png')
if (!existsSync(original) || !existsSync(tray)) throw new Error('Reference application icons are missing')
const staging = mkdtempSync(join(tmpdir(), 'xiaoyin-app-icon-'))
const iconset = join(staging, 'reference.iconset')
execFileSync('iconutil', ['--convert', 'iconset', original, '--output', iconset])
const source = join(iconset, 'icon_512x512@2x.png')
const generated = join(staging, 'generated')
execFileSync('pnpm', ['tauri', 'icon', source, '--output', generated], { cwd: root, stdio: 'inherit' })
const destination = join(root, 'src-tauri/icons')
mkdirSync(destination, { recursive: true })
// Desktop assets only; unused mobile icon sets are not part of this pipeline.
for (const entry of readdirSync(generated, { withFileTypes: true })) {
  if (entry.isFile() && /\.(png|ico|icns)$/.test(entry.name)) copyFileSync(join(generated, entry.name), join(destination, entry.name))
}
copyFileSync(source, join(destination, 'icon-source.png'))
// Preserve the reference's independently supplied macOS resolutions.
copyFileSync(original, join(destination, 'icon.icns'))
copyFileSync(tray, join(destination, 'trayTemplate@2x.png'))
mkdirSync(join(root, 'public'), { recursive: true })
copyFileSync(join(destination, 'icon.ico'), join(root, 'public/favicon.ico'))
console.log('Desktop icons and favicon imported. Conversion files:', staging)
