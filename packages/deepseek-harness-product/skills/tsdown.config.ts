import { defineConfig } from 'tsdown'

/** ESM modules consumed by the product Host and its single browser bundle. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : {
  entry: { index: 'src/index.ts', submission: 'src/submission.ts', client: 'src/client.ts' },
  outDir: 'lib', format: 'esm', platform: 'node',
  dts: true, clean: true, fixedExtension: false,
})
