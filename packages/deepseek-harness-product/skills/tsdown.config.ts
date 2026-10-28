import { defineConfig } from 'tsdown';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';
import { generateSkillRemote } from './scripts/generate-remote.ts';
/** Build builtin Host, browser and generated native Remote metadata. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : {
  entry: { index: 'src/index.ts', submission: 'src/submission.ts', client: 'src/client.ts', types: 'src/types.ts', remote: 'src/remote.ts' },
  outDir: 'lib', format: 'esm', platform: 'node',
  hooks: { 'build:prepare': async () => {
    await generateSkillRemote(true);
    // The standalone Host/Client compiler also owns this imported package's tests.
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'),
      '--project', fileURLToPath(new URL('./tsconfig.json', import.meta.url)), '--noEmit'], { stdio: 'inherit' });
  } },
  // Source metadata is generated above; reuse only native decorator lowering for this product-only package.
  plugins: [{ name: 'skills-native-decorators', transform: typertPlugin().transform }],
  dts: true, clean: true, fixedExtension: false,
});
