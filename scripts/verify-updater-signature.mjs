import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error('Invalid signature encoding')
  return Buffer.from(value.trim(), 'base64')
}

// Tauri wraps Minisign documents in base64. Verify both the archive signature
// and the trusted comment using Node's Ed25519 implementation.
export function verifyUpdaterSignature(data, encodedSignature, encodedPublicKey) {
  const publicLines = decode(encodedPublicKey).toString('utf8').trim().split(/\r?\n/)
  const lines = decode(encodedSignature).toString('utf8').trim().split(/\r?\n/)
  const publicBytes = decode(publicLines[1])
  const signatureBytes = decode(lines[1])
  const globalSignature = decode(lines[3])
  if (publicBytes.length !== 42 || signatureBytes.length !== 74 || globalSignature.length !== 64 || !lines[2]?.startsWith('trusted comment: ')) throw new Error('Invalid Minisign document')
  if (!['Ed', 'ED'].includes(publicBytes.subarray(0, 2).toString())) throw new Error('Unsupported public key algorithm')
  if (!publicBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10))) throw new Error('Updater signing key does not match the application public key')
  const algorithm = signatureBytes.subarray(0, 2).toString()
  if (!['Ed', 'ED'].includes(algorithm)) throw new Error('Unsupported signature algorithm')
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes.subarray(10)]), format: 'der', type: 'spki' })
  const signature = signatureBytes.subarray(10)
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data
  if (!verify(null, message, key, signature)) throw new Error('Updater archive signature is invalid')
  const comment = Buffer.from(lines[2].slice('trusted comment: '.length))
  if (!verify(null, Buffer.concat([signature, comment]), key, globalSignature)) throw new Error('Updater trusted comment signature is invalid')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archive, configPath] = process.argv.slice(2)
  if (!archive || !configPath) throw new Error('Usage: node verify-updater-signature.mjs <archive> <tauri.conf.json>')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  verifyUpdaterSignature(readFileSync(archive), readFileSync(`${archive}.sig`, 'utf8'), config.plugins.updater.pubkey)
  console.log('Updater signature matches the application public key')
}
