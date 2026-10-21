import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export function secureFixture() {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const bytes = Buffer.concat([cipher.update(value), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes])
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString()
    },
  }
}
