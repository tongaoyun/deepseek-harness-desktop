/** Independent process owning the product content store until its actual exit. */
import { prepareProductContentStorage } from '../../src/content-retention.ts'

const root = process.argv[2]
if (root === undefined) throw new Error('Missing private fixture store')
await prepareProductContentStorage(root, message => process.stderr.write(`${message}\n`), async () => ({ retainedFiles: new Set(), requiredFiles: new Set() }))
await new Promise<void>((resolve, reject) => process.send?.({ ready: true }, (error) => {
  if (error) reject(error)
  else resolve()
}))
if (process.argv[3] === 'hold') await new Promise<void>(resolve => process.once('message', () => { resolve() }))
process.disconnect()
