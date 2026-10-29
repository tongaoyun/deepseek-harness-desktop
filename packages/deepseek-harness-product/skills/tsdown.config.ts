import { defineConfig } from 'tsdown';
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';
import { generateSkillRemote } from './scripts/generate-remote.ts';
/** Build builtin Host, browser and generated native Remote metadata in separate compiler programs. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  {
    entry: { index: 'src/index.ts', submission: 'src/submission.ts', types: 'src/types.ts' },
    tsconfig: './tsconfig.host.json',
    outDir: 'lib', format: 'esm', platform: 'node',
    hooks: { 'build:prepare': async () => {
      await generateSkillRemote(true);
    } },
    // Source metadata is generated above; reuse only native decorator lowering for this product-only package.
    plugins: [{ name: 'skills-native-decorators', transform: typertPlugin().transform }],
    dts: true, clean: true, fixedExtension: false,
  },
  {
    entry: { client: 'src/client.ts', remote: 'src/remote.ts' },
    tsconfig: './tsconfig.client.json',
    outDir: 'lib', format: 'esm', platform: 'node',
    dts: true, clean: true, fixedExtension: false,
  },
]);
