import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const script = fileURLToPath(new URL('./macos-build-env.sh', import.meta.url))
function config(arch, cargo = '') {
  const env = { ...process.env, XIAOYIN_MACOS_ARCH: arch, CARGO_TARGET_DIR: cargo }
  return execFileSync('/bin/bash', ['-c', 'repository="/tmp/project with spaces"; source "$1"; printf "%s\\n" "$macos_arch" "$node_arch" "$artifact_arch" "$binary_arch" "$rust_target" "$target_dir"', '_', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')
}
test('Intel target uses Intel runtime and an architecture-specific Cargo directory', () => {
  assert.deepEqual(config('x64', '/tmp/target'), ['x64', 'x64', 'x64', 'x86_64', 'x86_64-apple-darwin', '/tmp/target/x86_64-apple-darwin'])
  assert.deepEqual(config('x86_64', '/tmp/target'), config('x64', '/tmp/target'))
})
test('Apple Silicon and relative Cargo paths remain distinct', () => {
  assert.deepEqual(config('arm64', 'build'), ['arm64', 'arm64', 'aarch64', 'arm64', 'aarch64-apple-darwin', '/tmp/project with spaces/build/aarch64-apple-darwin'])
  assert.equal(config('x64').at(-1), '/tmp/project with spaces/src-tauri/target/x86_64-apple-darwin')
  assert.deepEqual(config('aarch64'), config('arm64'))
})
test('invalid and universal targets are rejected rather than silently using host binaries', () => {
  assert.throws(() => config('universal'))
  assert.throws(() => config('../arm64'))
})
test('implicit native builds keep the standard Cargo directory', () => {
  assert.equal(config('', '/tmp/target').at(-1), '/tmp/target')
})
test('CI allows architectures to build in parallel when runners are available', () => {
  const workflow = readFileSync(new URL('../.gitea/workflows/macos-installer.yml', import.meta.url), 'utf8')
  assert.match(workflow, /max-parallel: 2/)
  assert.match(workflow, /CARGO_BUILD_JOBS: "2"/)
  assert.match(workflow, /XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: "300000"/)
  assert.match(workflow, /CARGO_TARGET_DIR: \/tmp\/xiaoyin-desktop-builder\/target\/\$\{\{ matrix\.architecture \}\}/)
  assert.match(workflow, /runs-on: macos-arm64/)
  assert.doesNotMatch(workflow, /runs-on:.*macos-x64/)
  assert.match(workflow, /--target "\$rust_target"/)
  assert.match(workflow, /app="\$target_dir\/release\/bundle/)
})

test('staged runtime checks run once against the final disk image', () => {
  const prepare = readFileSync(new URL('./prepare-harness-runtime-macos.sh', import.meta.url), 'utf8')
  const smoke = readFileSync(new URL('./smoke-test-macos-bundle.sh', import.meta.url), 'utf8')
  assert.doesNotMatch(prepare, /check-(harness|macos)-runtime/)
  assert.doesNotMatch(prepare, /SHASUMS256/)
  assert.match(prepare, /download-official-harness-runtime\.mjs/)
  const manifest = JSON.parse(readFileSync(new URL('./official-harness-runtime.json', import.meta.url), 'utf8'))
  assert.match(manifest.targets['mac-arm64'].sha256, /^[a-f0-9]{64}$|^REPLACE_MAC_ARM64_SHA256$/)
  assert.match(manifest.targets['mac-x64'].sha256, /^[a-f0-9]{64}$|^REPLACE_MAC_X64_SHA256$/)
  assert.match(prepare, /XIAOYIN_BUILD_CACHE_DIR/)
  assert.match(smoke, /check-macos-runtime\.mjs/)
  assert.match(smoke, /check-harness-runtime\.mjs/)
})

test('macOS release builds load a configured signing key file for Tauri', () => {
  const build = readFileSync(new URL('./build-macos.sh', import.meta.url), 'utf8')
  assert.match(build, /! -f "\$TAURI_SIGNING_PRIVATE_KEY_PATH" \|\| ! -r "\$TAURI_SIGNING_PRIVATE_KEY_PATH"/)
  assert.match(build, /export TAURI_SIGNING_PRIVATE_KEY="\$\(<"\$TAURI_SIGNING_PRIVATE_KEY_PATH"\)"/)
  assert.match(build, /unset TAURI_SIGNING_PRIVATE_KEY_PATH/)
})

test('bundle architecture checks accept the binary path before lipo variable arguments', { skip: process.platform !== 'darwin' }, () => {
  const smoke = readFileSync(new URL('./smoke-test-macos-bundle.sh', import.meta.url), 'utf8')
  assert.match(smoke, /lipo "\$runtime\/harness-host\/native\/xiaoyin-computer-use" -verify_arch "\$binary_arch"/)
  const checks = smoke.split('\n').filter((line) => line.startsWith('/usr/bin/lipo '))
    .map((line) => line.replace('$runtime/harness-host/native/xiaoyin-computer-use', '$binary')).join('\n')
  assert.equal(checks.split('\n').length, 3)
  const run = (arch) => execFileSync('/bin/bash', ['-e', '-c', checks], {
    env: { ...process.env, binary: process.execPath, node_binary: process.execPath, binary_arch: arch },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  run(process.arch === 'arm64' ? 'arm64' : 'x86_64')
  assert.throws(() => run('ppc'))
})
