import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyReleaseIdentity } from './verify-release-ref.mjs'

const commit = '0123456789abcdef0123456789abcdef01234567'

test('accepts an exact version tag on the current main commit', () => {
  assert.doesNotThrow(() => verifyReleaseIdentity({ refName: 'v1.2.3', commit, mainCommit: commit.toUpperCase(), version: '1.2.3' }))
})

test('rejects a mismatched tag, non-main commit and malformed identity', () => {
  assert.throws(() => verifyReleaseIdentity({ refName: 'v1.2.4', commit, mainCommit: commit, version: '1.2.3' }), /does not match/)
  assert.throws(() => verifyReleaseIdentity({ refName: 'v1.2.3', commit, mainCommit: 'f'.repeat(40), version: '1.2.3' }), /current main/)
  assert.throws(() => verifyReleaseIdentity({ refName: 'v1.2.3', commit: 'short', mainCommit: commit, version: '1.2.3' }), /full commit SHA/)
  assert.throws(() => verifyReleaseIdentity({ refName: 'vnext', commit, mainCommit: commit, version: 'next' }), /invalid release version/)
})
