import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const cargoToml = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
const cargoLock = await readFile(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8')

const cargoManifestVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const desktopLockBlock = cargoLock.split(/\n(?=\[\[package\]\]\n)/)
  .find((block) => /^name\s*=\s*"xiaoyin-desktop"$/m.test(block))
const cargoLockVersion = desktopLockBlock?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const versions = {
  'package.json': packageJson.version,
  'src-tauri/tauri.conf.json': tauriConfig.version,
  'src-tauri/Cargo.toml': cargoManifestVersion,
  'src-tauri/Cargo.lock[xiaoyin-desktop]': cargoLockVersion,
}
const unique = new Set(Object.values(versions))
if ([...Object.values(versions)].some((value) => typeof value !== 'string') || unique.size !== 1) {
  throw new Error(`Desktop version mismatch: ${JSON.stringify(versions)}`)
}
console.log(`Desktop version consistency passed: ${packageJson.version}`)
