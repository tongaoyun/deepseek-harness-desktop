import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { generateExpertRemote } from './scripts/generate-remote.ts'

/** Build the Host service and browser client with native decorator lowering. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : {
  entry: { index: 'src/index.ts', remote: 'src/remote.ts', client: 'src/client.ts', types: 'src/types.ts' },
  outDir: 'lib', format: 'esm', platform: 'node',
  hooks: { 'build:prepare': async () => {
    await generateExpertRemote(true)
  } },
  plugins: [{ name: 'experts-native-decorators', transform: typertPlugin().transform }],
  external: ['react-dom', 'react-dom/client'],
  dts: true, fixedExtension: false, clean: true,
})
