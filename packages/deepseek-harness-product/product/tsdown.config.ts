import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const zodLicense = readFileSync(require.resolve('zod/package.json').replace(/package\.json$/u, 'LICENSE'), 'utf8')
const yamlLicense = readFileSync(require.resolve('yaml/package.json').replace(/package\.json$/u, 'LICENSE'), 'utf8')

/** Bundle the product boundary for Electron's main process and preload. */
export default defineConfig([{
  entry: ['lib/types/index.js', 'lib/types/protocol.js', 'lib/types/bridge.js', 'lib/types/dingtalk-auth.js', 'lib/types/errors.js', 'lib/types/catalog-manager.js', 'lib/types/catalog.js', 'lib/types/connector-draft.js', 'lib/types/company-team.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}, {
  // The AI publication skill copies this self-contained artifact into sparse checkouts.
  entry: ['lib/types/company-content.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { alwaysBundle: ['yaml', 'zod'] },
  banner: `/*! Bundled yaml:\n${yamlLicense}\nBundled zod:\n${zodLicense}*/`,
}])
