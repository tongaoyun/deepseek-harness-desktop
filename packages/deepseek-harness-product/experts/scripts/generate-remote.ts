/** Generate source-plane Remote metadata from the actual Host methods with the native Typert compiler. */
import { generateRemote } from './generate-remote-shared.ts'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Generate or verify this package's source-plane contracts.
 * @param check Reject stale generated files instead of rewriting them.
 */
export async function generateExpertRemote(check = false): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  await generateRemote({ packageRoot, packageName: '@deepseek-harness/product-experts', tempPrefix: 'experts-typert-', label: 'Experts', remoteName: 'expert', references: [fileURLToPath(new URL('../../product/tsconfig.json', import.meta.url))] }, check)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateExpertRemote(process.argv.includes('--check'))
