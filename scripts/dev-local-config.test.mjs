import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localDevelopmentPort, localDevelopmentTauriConfig } from './dev-local-config.mjs'

test('accepts automatic or explicit local development ports', () => {
  assert.equal(localDevelopmentPort(undefined), 0)
  assert.equal(localDevelopmentPort(''), 0)
  assert.equal(localDevelopmentPort('58151'), 58151)
  assert.equal(localDevelopmentPort('65535'), 65535)
  for (const value of ['0', '-1', '1.5', ' 58151', '65536', 'invalid']) {
    assert.throws(() => localDevelopmentPort(value), /XIAOYIN_LOCAL_DEV_PORT/u)
  }
})

test('keeps the local Tauri identity and defers its isolated WebView creation', () => {
  const config = localDevelopmentTauriConfig('http://127.0.0.1:58151')
  assert.equal(config.identifier, 'com.instudio.xiaoyin.desktop.local-test')
  assert.equal(config.build.devUrl, 'http://127.0.0.1:58151')
  assert.equal(config.app.windows[0].create, false)
  assert.equal('dataStoreIdentifier' in config.app.windows[0], false)
  assert.deepEqual(config.app.windows.map((window) => window.label), ['main'])

  const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(rust, /cfg\(debug_assertions\)/u)
  assert.match(rust, /XIAOYIN_LOCAL_DEV_WEBVIEW_ISOLATION/u)
  assert.match(rust, /app\.config\(\)\.identifier != "com\.instudio\.xiaoyin\.desktop\.local-test"/u)
  assert.match(rust, /data_store_identifier\(\*b"xiaoyin-local-01"\)/u)
  assert.match(rust, /data_directory\(app_data\.join\("webview"\)\)/u)
})
