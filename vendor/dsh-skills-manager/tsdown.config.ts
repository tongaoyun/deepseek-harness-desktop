import { defineConfig } from 'tsdown'

const ID = '@michengai/dsh-skills-manager'
const externals = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives']

export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? {
  entry: { client: 'src/client.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser',
  dts: false, clean: false, minify: true,
  deps: { neverBundle: externals },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
} : {
  entry: ['src/index.ts', 'src/core.ts'], outDir: 'lib', format: 'esm', platform: 'node',
  dts: true, clean: false, fixedExtension: false,
})
