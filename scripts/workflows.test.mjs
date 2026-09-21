import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const directory = new URL('../.gitea/workflows/', import.meta.url)
const read = (name) => readFileSync(new URL(name, directory), 'utf8')
const mac = read('macos-installer.yml')
const win = read('windows-installer.yml')
const windowsRuntime = readFileSync(new URL('../scripts/prepare-harness-runtime.ps1', import.meta.url), 'utf8')
const quickWindows = JSON.parse(readFileSync(new URL('../src-tauri/tauri.quick.windows.conf.json', import.meta.url), 'utf8'))
function expression(text, field, context) {
  const source = text.match(new RegExp(`^\\s*${field}: \\$\\{\\{ (.+) \\}\\}\\s*$`, 'm'))?.[1]
  assert.ok(source, `Missing ${field} expression`)
  return JSON.parse(JSON.stringify(runInNewContext(source, {
    ...context,
    fromJSON: JSON.parse,
    startsWith: (value, prefix) => value.startsWith(prefix),
  }, { timeout: 1000 })))
}
function context(event, inputs = {}, ref = event === 'push' ? 'refs/tags/v1.0.0' : 'refs/heads/test') {
  return { github: { event_name: event, ref }, inputs }
}

test('exactly three workflow entries retain shared checks and platform installers', () => {
  assert.deepEqual(readdirSync(directory).filter(n => n.endsWith('.yml')).sort(), ['ci.yml', 'macos-installer.yml', 'windows-installer.yml'])
  const ci = read('ci.yml')
  assert.match(ci, /  web-and-harness:/)
  assert.match(ci, /  rust-windows:/)
  assert.match(ci, /cargo test\n/)
  assert.doesNotMatch(ci, /cargo test --no-run/)
})
test('macOS release reuses main CI and can package both architectures in parallel', () => {
  const build = mac.split('  build-macos:')[1].split('  publish-macos-update:')[0]
  assert.doesNotMatch(mac, /  quality:/)
  assert.doesNotMatch(build, /needs: quality/)
  assert.match(build, /max-parallel: 2/)
  assert.match(build, /CARGO_BUILD_JOBS: "2"/)
  assert.match(build, /XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: "300000"/)
  assert.match(build, /CARGO_TARGET_DIR: \/tmp\/xiaoyin-desktop-builder\/target\/\$\{\{ matrix\.architecture \}\}/)
  assert.match(build, /pnpm verify:version/)
  assert.doesNotMatch(build, /XIAOYIN_HTTPS_SERVER_URL|VITE_XIAOYIN_SERVER_URL/)
  assert.doesNotMatch(build, /pnpm (lint|typecheck|test)|cargo (clippy|test)/)
  assert.match(build, /smoke-test-macos-bundle.sh/)
  assert.match(mac, /default: arm64/)
})
test('macOS accepts selected architecture and always builds both on a version tag', () => {
  for (const [architecture, expected] of [['arm64', ['arm64']], ['x64', ['x64']], ['all', ['arm64', 'x64']]]) {
    assert.deepEqual(expression(mac, 'architecture', context('workflow_dispatch', { architecture })), expected)
  }
  assert.deepEqual(expression(mac, 'architecture', context('workflow_dispatch', { architecture: 'arm64' }, 'refs/tags/v1.0.0')), ['arm64', 'x64'])
  assert.deepEqual(expression(mac, 'architecture', context('push')), ['arm64', 'x64'])
})
test('manual builds supersede manual builds but never cancel release runs', () => {
  for (const workflow of [mac, win]) {
    assert.equal(expression(workflow, 'cancel-in-progress', context('workflow_dispatch')), true)
    assert.equal(expression(workflow, 'cancel-in-progress', context('workflow_dispatch', {}, 'refs/tags/v1.0.0')), false)
    assert.equal(expression(workflow, 'cancel-in-progress', context('push')), false)
    assert.match(workflow, /group: .+startsWith\(github\.ref, 'refs\/tags\/v'\).+release.+manual/)
  }
  assert.match(win, /group: windows-installer-/)
})
test('Windows quick mode is explicit and cannot weaken a tag release', () => {
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('workflow_dispatch', { build_mode: 'quick' })), 'quick')
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('workflow_dispatch')), 'release')
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('workflow_dispatch', { build_mode: 'quick' }, 'refs/tags/v1.0.0')), 'release')
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('push', { build_mode: 'quick' })), 'release')
  assert.match(win, /--debug --features windows-no-console --bundles nsis/)
  assert.match(win, /XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: "300000"/)
  assert.match(win, /New-Item -ItemType Junction -Path \$Link -Target \$Runtime/)
  assert.match(win, /resources\/harness-runtime\//)
  assert.match(win, /pnpm tauri build --verbose --config \$ConfigPath/)
  assert.doesNotMatch(win, /XIAOYIN_HTTPS_SERVER_URL|VITE_XIAOYIN_SERVER_URL/)
  assert.doesNotMatch(win, /pnpm (lint|typecheck|test)|cargo (fmt|clippy|test)/)
  assert.doesNotMatch(win, /run_install_smoke/)
  assert.match(win, /if: \$\{\{ env\.XIAOYIN_BUILD_MODE == 'release' \}\}/)
  assert.match(windowsRuntime, /platformPackagePattern/)
  assert.match(windowsRuntime, /nodePtyPrebuilds/)
  assert.match(windowsRuntime, /\.d\.ts.*\.map/)
  const publisher = readFileSync(new URL('../scripts/publish-gitea-release.ps1', import.meta.url), 'utf8')
  assert.match(publisher, /function Invoke-BinaryUploadBatch/)
  assert.match(publisher, /ThrottleLimit = 3/)
  assert.match(publisher, /\$versionPattern = .*\[regex\]::Escape\(\$version\)/)
  assert.doesNotMatch(publisher, /expectedVersionToken/)
  assert.doesNotMatch(publisher, /foreach \(\$asset in \$releaseAssets\)/)
  assert.match(win, /ExpectedCount = if \(\$Quick\) \{ 1 \} else \{ 2 \}/)
  assert.match(win, /\$VersionPattern = .*\[regex\]::Escape\(\$ExpectedVersion\)/)
  assert.doesNotMatch(win, /-like "\*_\$\{ExpectedVersion\}_\*"/)
  assert.match(win, /name: xiaoyin-desktop-windows-\$\{\{ env.XIAOYIN_BUILD_MODE \}\}/)
  assert.deepEqual(quickWindows.bundle.resources, [])
  assert.equal(quickWindows.bundle.createUpdaterArtifacts, false)
})

test('CI owns quality checks and validates every PowerShell script', () => {
  const ci = read('ci.yml')
  const web = ci.split('  web-and-harness:')[1].split('  rust-windows:')[0]
  assert.match(web, /pnpm check:web/)
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts
  for (const command of ['verify:version', 'lint', 'typecheck', 'test', 'build', 'acceptance:harness-runtime', 'acceptance:harness-contracts', 'acceptance:tool-policy', 'acceptance:session-query']) {
    assert.match(scripts['check:web'], new RegExp(`pnpm ${command}`))
  }
  assert.match(scripts.check, /pnpm check:web/)
  assert.doesNotMatch(web, /node harness-host\/scripts\/acceptance-/)
  assert.doesNotMatch(web, /node --test scripts\//)
  assert.match(ci, /Get-ChildItem scripts -File -Filter '\*\.ps1'/)
})

test('installer jobs use concise labels and bounded execution time', () => {
  assert.match(mac, /name: 构建 \$\{\{ matrix\.architecture \}\}/)
  assert.match(mac, /name: 发布更新索引/)
  assert.match(win, /name: 构建 x64/)
  for (const workflow of [read('ci.yml'), mac, win]) {
    assert.match(workflow, /timeout-minutes:/)
  }
})
