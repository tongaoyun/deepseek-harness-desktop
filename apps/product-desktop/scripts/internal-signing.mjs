/** Fixed private macOS identity for internal distribution, without changing certificate trust. */
import { execFile } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** @param {string} command Apple executable. @param {string[]} args Private command arguments. @returns {Promise<string>} Standard output; failures omit credentials and arguments. */
async function execute(command, args) {
  try { return (await promisify(execFile)(command, args, { timeout: 120_000, encoding: 'utf8' })).stdout }
  catch { throw new Error(`Internal signing: ${command.split('/').at(-1)} failed; inspect the private signing configuration`) }
}

/** @param {string} pem Imported public certificate. @param {string} expectedSHA256 Pinned company test identity. @param {number} now Current timestamp. @returns {{sha1: string, sha256: string}} Valid fixed self-signed identity. */
export function internalCertificateIdentity(pem, expectedSHA256, now = Date.now()) {
  if (!/^[A-F0-9]{64}$/u.test(expectedSHA256 ?? '')) throw new Error('Internal signing requires the pinned certificate SHA-256')
  const certificate = new X509Certificate(pem)
  const sha256 = certificate.fingerprint256.replaceAll(':', '')
  if (sha256 !== expectedSHA256) throw new Error(`Internal signing certificate differs from the pinned identity: expected ${expectedSHA256}, received ${sha256}`)
  if (!certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
    throw new Error('Internal signing certificate is not a valid self-signed identity')
  }
  if (!certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.3')) throw new Error('Internal signing certificate lacks the code-signing purpose')
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error(`Internal signing certificate is outside its valid period: ${certificate.validFrom} to ${certificate.validTo}; checked at ${new Date(now).toISOString()}`)
  }
  return { sha1: certificate.fingerprint.replaceAll(':', ''), sha256 }
}

/**
 * Import the fixed identity only for the complete packaging operation, then restore the search list and remove owned credentials.
 * @param {NodeJS.ProcessEnv} environment Explicit internal distribution settings.
 * @param {(environment: NodeJS.ProcessEnv) => Promise<void>} action Packaging that must settle before cleanup.
 * @param {(command: string, args: string[]) => Promise<string>} run Credential-safe Apple command executor.
 * @returns {Promise<void>} Resolves after packaging and keychain removal; cleanup failures also reject.
 */
export async function withInternalMacIdentity(environment, action, run = execute) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-internal-signing-'))
  const keychain = join(directory, 'signing.keychain-db')
  const password = randomBytes(32).toString('base64')
  const security = args => run('/usr/bin/security', args)
  const searchList = async () => (await security(['list-keychains', '-d', 'user']))
    .split('\n').map(line => line.trim().replace(/^"|"$/gu, '')).filter(Boolean)
  let created = false
  let added = false
  try {
    const encoded = environment.PACKAGE_INTERNAL_CERTIFICATE_BASE64
    const file = environment.PACKAGE_INTERNAL_CERTIFICATE_FILE
    const exportPassword = environment.PACKAGE_INTERNAL_CERTIFICATE_PASSWORD
    if (exportPassword === undefined || Boolean(encoded) === Boolean(file)) {
      throw new Error('Internal signing requires one fixed PKCS#12 input and its password')
    }
    if (encoded !== undefined && (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length > 192 * 1024)) {
      throw new Error('Internal signing PKCS#12 encoding is invalid')
    }
    const certificate = join(directory, 'identity.p12')
    await writeFile(certificate, encoded === undefined ? await readFile(file) : Buffer.from(encoded, 'base64'), { mode: 0o600, flag: 'wx' })
    await security(['create-keychain', '-p', password, keychain])
    created = true
    await security(['unlock-keychain', '-p', password, keychain])
    await security(['set-keychain-settings', '-lut', '7200', keychain])
    await security(['import', certificate, '-k', keychain, '-P', exportPassword, '-T', '/usr/bin/codesign'])
    await security(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain])
    const identity = internalCertificateIdentity(await security(['find-certificate', '-a', '-p', keychain]), environment.PACKAGE_INTERNAL_CERTIFICATE_SHA256)
    const previous = await searchList()
    await security(['list-keychains', '-d', 'user', '-s', keychain, ...previous])
    added = true
    const child = { ...environment, PRODUCT_INTERNAL_KEYCHAIN: keychain, PRODUCT_INTERNAL_CERTIFICATE_SHA1: identity.sha1 }
    delete child.PACKAGE_INTERNAL_CERTIFICATE_BASE64
    delete child.PACKAGE_INTERNAL_CERTIFICATE_FILE
    delete child.PACKAGE_INTERNAL_CERTIFICATE_PASSWORD
    await action(child)
  } finally {
    try {
      if (added) {
        // Preserve unrelated changes to the search list made while packaging was running.
        const current = await searchList()
        await security(['list-keychains', '-d', 'user', '-s', ...current.filter(path => path !== keychain)])
      }
    } finally {
      try { if (created) await security(['delete-keychain', keychain]) }
      finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
}
