import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const directory = new URL('../.gitea/workflows/', import.meta.url)
const read = (name) => readFileSync(new URL(name, directory), 'utf8')
const mac = read('macos-installer.yml')
const win = read('windows-installer.yml')
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

test('exactly four workflow entries retain Windows checks and manual rollback', () => {
  assert.deepEqual(readdirSync(directory).filter(n => n.endsWith('.yml')).sort(), ['ci.yml', 'macos-installer.yml', 'rollback-release.yml', 'windows-installer.yml'])
  const ci = read('ci.yml')
  assert.match(ci, /  web-and-harness:/)
  assert.match(ci, /  rust-windows:/)
  assert.match(ci, /cargo test\n/)
  assert.doesNotMatch(ci, /cargo test --no-run/)
  const rollback = read('rollback-release.yml')
  assert.match(rollback, /^name: Windows 更新回退$/m)
  assert.match(rollback, /workflow_dispatch:/)
  assert.doesNotMatch(rollback, /\n  (push|pull_request):/)
})
test('macOS release reuses main CI and packages both architectures concurrently', () => {
  const build = mac.split('  build-macos:')[1].split('  publish-macos-update:')[0]
  assert.doesNotMatch(mac, /  quality:/)
  assert.doesNotMatch(build, /needs: quality/)
  assert.match(build, /max-parallel: 2/)
  assert.match(build, /CARGO_BUILD_JOBS: "3"/)
  assert.match(build, /XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: "300000"/)
  assert.match(build, /CARGO_TARGET_DIR: \/tmp\/xiaoyin-desktop-builder\/target\/\$\{\{ matrix\.architecture \}\}/)
  assert.match(build, /pnpm verify:version/)
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
  assert.match(read('rollback-release.yml'), /group: windows-installer-release/)
})
test('Windows quick mode is explicit and cannot weaken a tag release', () => {
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('workflow_dispatch', { build_mode: 'quick' })), 'quick')
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('workflow_dispatch')), 'release')
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('workflow_dispatch', { build_mode: 'quick' }, 'refs/tags/v1.0.0')), 'release')
  assert.equal(expression(win, 'XIAOYIN_BUILD_MODE', context('push', { build_mode: 'quick' })), 'release')
  assert.match(win, /--debug --features windows-no-console --bundles nsis/)
  assert.doesNotMatch(win, /pnpm (lint|typecheck|test)|cargo (fmt|clippy|test)/)
  assert.doesNotMatch(win, /run_install_smoke/)
  assert.match(win, /if: \$\{\{ env\.XIAOYIN_BUILD_MODE == 'release' \}\}/)
  assert.match(win, /ExpectedCount = if \(\$Quick\) \{ 1 \} else \{ 2 \}/)
  assert.match(win, /name: xiaoyin-desktop-windows-\$\{\{ env.XIAOYIN_BUILD_MODE \}\}/)
})

test('CI owns quality checks and validates every PowerShell script', () => {
  const ci = read('ci.yml')
  assert.match(ci, /pnpm lint/)
  assert.match(ci, /pnpm test/)
  assert.match(ci, /pnpm build/)
  assert.doesNotMatch(ci, /pnpm typecheck/)
  assert.match(ci, /Get-ChildItem scripts -File -Filter '\*\.ps1'/)
  assert.match(ci, /scripts\/verify-release-ref\.test\.mjs/)
})

test('installer jobs use concise labels and bounded execution time', () => {
  assert.match(mac, /name: 构建 \$\{\{ matrix\.architecture \}\}/)
  assert.match(mac, /name: 发布更新索引/)
  assert.match(win, /name: 构建 x64/)
  assert.match(read('rollback-release.yml'), /name: 回退更新索引/)
  for (const workflow of [read('ci.yml'), mac, win, read('rollback-release.yml')]) {
    assert.match(workflow, /timeout-minutes:/)
  }
})
