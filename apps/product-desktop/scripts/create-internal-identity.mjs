/** Create an explicitly requested persistent internal identity outside the checkout; never rotate an existing identity. */
import { execFile } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const { values } = parseArgs({ options: { directory: { type: 'string' } } })
if (!values.directory || !isAbsolute(values.directory)) throw new Error('Select an absolute private configuration directory outside the checkout')
const directory = resolve(values.directory)
const root = resolve(import.meta.dirname, '../../..')
if (directory === root || directory.startsWith(root + sep)) throw new Error('Signing credentials must remain outside the checkout')
await mkdir(directory, { mode: 0o700, recursive: false })
const password = randomBytes(32).toString('base64')
const environment = { ...process.env, HARNESS_INTERNAL_EXPORT_PASSWORD: password }
const key = join(directory, 'private.pem')
const certificate = join(directory, 'certificate.pem')
try {
  const execute = async args => {
    try { await promisify(execFile)('openssl', args, { env: environment, timeout: 60_000 }) }
    catch { throw new Error('Internal identity creation failed; no existing certificate was replaced') }
  }
  await execute(['req', '-x509', '-newkey', 'rsa:4096', '-nodes', '-days', '3650',
    '-subj', '/CN=DeepSeek Harness Internal Distribution/O=Instudio',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,digitalSignature,keyCertSign',
    '-addext', 'extendedKeyUsage=critical,codeSigning', '-keyout', key, '-out', certificate])
  await execute(['pkcs12', '-export', '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-inkey', key, '-in', certificate,
    '-out', join(directory, 'identity.p12'), '-passout', 'env:HARNESS_INTERNAL_EXPORT_PASSWORD'])
  await chmod(join(directory, 'identity.p12'), 0o600)
  await writeFile(join(directory, 'password'), password, { mode: 0o600, flag: 'wx' })
  const parsed = new X509Certificate(await readFile(certificate))
  const metadata = { certificateSHA256: parsed.fingerprint256.replaceAll(':', ''), validTo: parsed.validTo, notarized: false }
  await writeFile(join(directory, 'identity.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(`Created fixed internal signing identity. SHA-256: ${metadata.certificateSHA256}`)
} finally { await rm(key, { force: true }) }
