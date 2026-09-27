import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveTauriServerUrl, tauriSecurityConfig } from './tauri-security-config.mjs'

const tauriRoot = fileURLToPath(new URL('../src-tauri', import.meta.url))

test('adds the configured server origin to the packaged desktop CSP', () => {
  const csp = tauriSecurityConfig('https://xiaoyin.example.com:8443/base').app.security.csp
  assert.match(csp, /connect-src [^;]*https:\/\/xiaoyin\.example\.com:8443/)
  assert.doesNotMatch(csp, /\/base/)
  assert.match(csp, /default-src 'self'/)
})

test('rejects non-network server URLs', () => {
  assert.throws(() => tauriSecurityConfig('file:///tmp/server'), /absolute HTTP\(S\) URL/)
  assert.throws(() => tauriSecurityConfig('not a URL'), /absolute HTTP\(S\) URL/)
})

test('reads the server URL from Vite environment files and lets process variables override it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xiaoyin-tauri-env-'))
  try {
    writeFileSync(join(directory, '.env.local'), 'VITE_XIAOYIN_SERVER_URL=https://env.example.test/api\n')
    assert.equal(resolveTauriServerUrl('dev', directory, {}), 'https://env.example.test/api')
    assert.equal(resolveTauriServerUrl('dev', directory, { VITE_XIAOYIN_SERVER_URL: 'https://process.example.test' }), 'https://process.example.test')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('uses the company server by default and limits release HTTP to private networks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xiaoyin-tauri-release-env-'))
  try {
    assert.equal(resolveTauriServerUrl('build', directory, {}), 'http://192.168.2.67:30081')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(resolveTauriServerUrl('build', process.cwd(), {
    VITE_XIAOYIN_SERVER_URL: 'http://10.20.30.40:8080',
  }), 'http://10.20.30.40:8080')
  assert.equal(resolveTauriServerUrl('build', process.cwd(), {
    VITE_XIAOYIN_SERVER_URL: 'https://xiaoyin.example.com',
  }), 'https://xiaoyin.example.com')
  assert.throws(() => resolveTauriServerUrl('build', process.cwd(), {
    VITE_XIAOYIN_SERVER_URL: 'http://xiaoyin.example.com',
  }), /HTTP only for loopback or RFC1918/)
  assert.throws(() => resolveTauriServerUrl('build', process.cwd(), {
    VITE_XIAOYIN_SERVER_URL: 'http://8.8.8.8:8080',
  }), /HTTP only for loopback or RFC1918/)
})

test('keeps DingTalk OAuth in the system browser without a login window', () => {
  const directory = join(tauriRoot, 'capabilities')
  const workspace = JSON.parse(readFileSync(join(directory, 'default.json'), 'utf8'))
  assert.deepEqual(workspace.windows, ['main'])
  assert.ok(workspace.permissions.includes('process:default'))
  assert.ok(workspace.permissions.includes('updater:default'))
  assert.equal(readFileSync(join(tauriRoot, 'tauri.conf.json'), 'utf8').includes('dingtalk-login'), false)
})

test('keeps every native command behind an explicit per-window ACL', () => {
  const build = readFileSync(join(tauriRoot, 'build.rs'), 'utf8')
  const library = readFileSync(join(tauriRoot, 'src', 'lib.rs'), 'utf8')
  const capability = JSON.parse(readFileSync(join(tauriRoot, 'capabilities', 'default.json'), 'utf8'))
  const manifestCommands = [...build.matchAll(/^\s+"([a-z0-9_]+)",$/gm)].map((match) => match[1]).sort()
  const handlers = library.match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1]
  assert.ok(handlers, 'generate_handler command list is missing')
  const registeredCommands = handlers.split(',').map((entry) => entry.trim().split('::').at(-1)).filter(Boolean).sort()
  assert.deepEqual(manifestCommands, registeredCommands)
  const workspaceCommands = capability.permissions
    .filter((permission) => permission.startsWith('allow-'))
    .map((permission) => permission.slice('allow-'.length).replaceAll('-', '_'))
  assert.deepEqual(workspaceCommands.sort(), manifestCommands)
})
