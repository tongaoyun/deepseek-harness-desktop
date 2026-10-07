import assert from 'node:assert/strict'
import test from 'node:test'

import { compareReleases, inspectAvailableReleases, parseReleaseTag } from './check-upstream-release.mjs'

test('orders prerelease channels without treating a preview as a stable update', () => {
  assert.ok(compareReleases(parseReleaseTag('dsh-v0.2.0-rc.2'), parseReleaseTag('dsh-v0.2.0-alpha.9')) > 0)
  assert.deepEqual(inspectAvailableReleases('dsh-v0.2.0-rc.2', [
    'dsh-v0.2.0-rc.1',
    'dsh-v0.2.0-rc.2',
    'dsh-v0.2.1-alpha.1',
    'dsh-v0.2.1-canary.1',
  ]), { update: null, preview: 'dsh-v0.2.1-alpha.1' })
})

test('reports the newest RC or stable release without selecting alpha tags', () => {
  assert.deepEqual(inspectAvailableReleases('dsh-v0.2.0-rc.2', [
    'dsh-v0.2.1-alpha.2',
    'dsh-v0.2.1-rc.1',
    'dsh-v0.2.1-rc.2',
    'dsh-v0.2.2-alpha.1',
  ]), { update: 'dsh-v0.2.1-rc.2', preview: 'dsh-v0.2.2-alpha.1' })
})

test('rejects tags outside the pinned release format', () => {
  assert.throws(() => parseReleaseTag('v0.2.1'), /Invalid DeepSeek Harness release tag/u)
})
