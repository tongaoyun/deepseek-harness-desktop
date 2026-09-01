import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const cargoToml = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
const cargoLock = await readFile(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8')

const cargoManifestVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const cargoLockVersion = cargoPackageVersion(cargoLock, 'xiaoyin-desktop')
if (cargoPackageVersion('[[package]]\r\nname = "dependency"\r\nversion = "1.0.0"\r\n\r\n[[package]]\r\nname = "desktop"\r\nversion = "9.8.7"\r\n', 'desktop') !== '9.8.7') {
  throw new Error('Cargo.lock CRLF parser self-check failed')
}
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

function cargoPackageVersion(contents, packageName) {
  const normalized = contents.replace(/\r\n?/g, '\n')
  const block = normalized.split(/\n(?=\[\[package\]\]\n)/)
    .find((candidate) => new RegExp(`^name\\s*=\\s*"${escapeRegExp(packageName)}"$`, 'm').test(candidate))
  return block?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
