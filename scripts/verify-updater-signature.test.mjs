import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { verifyUpdaterSignature } from './verify-updater-signature.mjs'

function fixture(algorithm = 'ED') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const data = Buffer.from('Synthetic updater archive')
  const id = Buffer.from('12345678')
  const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const key = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), id, rawKey]).toString('base64')}\n`).toString('base64')
  const signature = sign(null, algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data, privateKey)
  const comment = 'timestamp:1\tfile:test.app.tar.gz'
  const lines = ['untrusted comment: test', Buffer.concat([Buffer.from(algorithm), id, signature]).toString('base64'), `trusted comment: ${comment}`, sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString('base64')]
  return { data, key, lines, encoded: Buffer.from(lines.join('\n')).toString('base64') }
}

for (const algorithm of ['ED', 'Ed']) {
  test(`valid ${algorithm} signature verifies and changed archive fails`, () => {
    const f = fixture(algorithm)
    verifyUpdaterSignature(f.data, f.encoded, f.key)
    assert.throws(() => verifyUpdaterSignature(Buffer.from('changed'), f.encoded, f.key), /archive signature/)
  })
}
test('wrong key, changed trusted comment and malformed signature fail', () => {
  const f = fixture()
  assert.throws(() => verifyUpdaterSignature(f.data, f.encoded, fixture().key), /signature/)
  f.lines[2] += ' changed'
  assert.throws(() => verifyUpdaterSignature(f.data, Buffer.from(f.lines.join('\n')).toString('base64'), f.key), /trusted comment/)
  assert.throws(() => verifyUpdaterSignature(f.data, 'invalid', f.key))
})
