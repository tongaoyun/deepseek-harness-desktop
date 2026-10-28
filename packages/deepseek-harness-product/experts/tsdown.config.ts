import { defineConfig } from 'tsdown'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { generateExpertRemote } from './scripts/generate-remote.ts'

/** Build the Host service and browser client with native decorator lowering. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : {
  entry: { index: 'src/index.ts', remote: 'src/remote.ts', client: 'src/client.ts', types: 'src/types.ts' },
  outDir: 'lib', format: 'esm', platform: 'node',
  hooks: { 'build:prepare': async () => {
    await generateExpertRemote(true)
    // This imported Host/Client package owns its standalone compiler boundary, including tests.
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'),
      '--project', fileURLToPath(new URL('./tsconfig.json', import.meta.url)), '--noEmit'], { stdio: 'inherit' })
  } },
  plugins: [{ name: 'experts-native-decorators', transform: typertPlugin().transform }],
  external: ['react-dom', 'react-dom/client'],
  dts: true, fixedExtension: false, clean: true,
})
