import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveTauriServerUrl, tauriSecurityConfig } from './tauri-security-config.mjs'

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
