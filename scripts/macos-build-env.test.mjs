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
test('CI uses one registered Runner serially and explicitly passes the Rust target', () => {
  const workflow = readFileSync(new URL('../.gitea/workflows/macos-installer.yml', import.meta.url), 'utf8')
  assert.match(workflow, /max-parallel: 1/)
  assert.match(workflow, /runs-on: macos-arm64/)
  assert.doesNotMatch(workflow, /runs-on:.*macos-x64/)
  assert.match(workflow, /--target "\$rust_target"/)
  assert.match(workflow, /app="\$target_dir\/release\/bundle/)
})

test('bundle architecture checks accept the binary path before lipo variable arguments', { skip: process.platform !== 'darwin' }, () => {
  const smoke = readFileSync(new URL('./smoke-test-macos-bundle.sh', import.meta.url), 'utf8')
  const checks = smoke.split('\n').filter((line) => line.startsWith('/usr/bin/lipo ')).join('\n')
  assert.equal(checks.split('\n').length, 2)
  const run = (arch) => execFileSync('/bin/bash', ['-e', '-c', checks], {
    env: { ...process.env, binary: process.execPath, node_binary: process.execPath, binary_arch: arch },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  run(process.arch === 'arm64' ? 'arm64' : 'x86_64')
  assert.throws(() => run('ppc'))
})
