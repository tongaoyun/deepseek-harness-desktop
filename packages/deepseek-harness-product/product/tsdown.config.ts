import { defineConfig } from 'tsdown'

/** Bundle the product boundary for Electron's main process and preload. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/protocol.js', 'lib/types/bridge.js', 'lib/types/dingtalk-auth.js', 'lib/types/errors.js', 'lib/types/catalog-manager.js', 'lib/types/connector-draft.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
