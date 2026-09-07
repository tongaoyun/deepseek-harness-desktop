import { test } from 'node:test'
import assert from 'node:assert/strict'
import { macUpdateManifest } from './publish-macos-update.mjs'
const manifests = ['arm64', 'x64'].map((arch) => ({ arch, version: '1.0.0', commit: 'abc', signature: `sig-${arch}`, files: [{ name: `xiaoyin_1.0.0_${arch}.app.tar.gz`, sha256: 'a'.repeat(64) }] }))
test('Darwin update targets map to architecture-specific signed artifacts', () => {
  const value = macUpdateManifest('1.0.0', 'abc', manifests, 'https://example.test/files')
  assert.match(value.platforms['darwin-aarch64'].url, /arm64/)
  assert.match(value.platforms['darwin-x86_64'].url, /x64/)
  assert.equal(value.platforms['darwin-aarch64'].signature, 'sig-arm64')
})
test('missing architecture or mixed commit blocks the update feed', () => {
  assert.throws(() => macUpdateManifest('1.0.0', 'abc', manifests.slice(0, 1), 'https://example.test'))
  assert.throws(() => macUpdateManifest('1.0.0', 'other', manifests, 'https://example.test'))
})
