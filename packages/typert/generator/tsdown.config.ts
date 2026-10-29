import { defineConfig } from 'tsdown'

/** Emit the runtime entry consumed by source workspace build tools. */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  clean: false,
  dts: false,
  fixedExtension: false,
})
