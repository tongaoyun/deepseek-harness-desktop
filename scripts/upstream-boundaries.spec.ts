import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { assertPublicImport, completeDiff, importSpecifiers, inventory, productOwned, verifyDependencies, verifyPatches, verifyPinnedBaseline } from './upstream-boundaries.mjs'

it('isolates the registered product knowledge guide without exempting other upgrade documents', () => {
  expect(productOwned('docs/upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.md')).toBe(true)
  expect(productOwned('docs/upgrade-guide/v0.2.1-alpha.2/product-support/guide.md')).toBe(true)
  expect(productOwned('docs/upgrade-guide/v0.2.1-alpha.4/product-knowledge-references/guide.md')).toBe(true)
  expect(productOwned('docs/upgrade-guide/v0.2.1-rc.2/product-expert-kit-selection/guide.md')).toBe(true)
  expect(productOwned('docs/upgrade-guide/v0.2.1-rc.2/product-native-sidecar/guide.md')).toBe(true)
  expect(productOwned('docs/upgrade-guide/v0.2.1-rc.2/official-profile/guide.md')).toBe(false)
  expect(productOwned('docs/upgrade-guide/v0.2.1-alpha.4/official-profile/guide.md')).toBe(false)
  expect(productOwned('docs/upgrade-guide/v0.2.1-alpha.2/official-profile/guide.md')).toBe(false)
})

it('owns only the product GitHub packaging workflow', () => {
  expect(productOwned('.github/workflows/product-desktop-package.yml')).toBe(true)
  expect(productOwned('.github/workflows/release.yml')).toBe(false)
  expect(productOwned('.github/workflows/unregistered.yml')).toBe(false)
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-upstream-boundary-'))
  onTestFinished(() =>{  rmSync(root, { recursive: true, force: true }) })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.test')
  git('config', 'user.name', 'Fixture')
  mkdirSync(join(root, 'apps/host/src'), { recursive: true })
  writeFileSync(join(root, 'apps/host/src/index.ts'), 'export const version = 1\n')
  writeFileSync(join(root, 'test.ts'), '// focused behavior fixture\n')
  git('add', '.')
  git('commit', '-qm', 'baseline')
  return { root, baseline: git('rev-parse', 'HEAD') }
}

it('verifies a stored official baseline without an upstream remote and rejects missing or mismatched tags', () => {
  const { root, baseline } = fixture()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const tag = 'dsh-v0.2.1-alpha.2'
  expect(() =>{  verifyPinnedBaseline(root, tag, baseline) }).toThrow('fetch refs/tags/')
  git('tag', tag, baseline)
  expect(git('remote')).toBe('')
  expect(() =>{  verifyPinnedBaseline(root, tag, baseline) }).not.toThrow()
  expect(() =>{  verifyPinnedBaseline(root, tag, '0'.repeat(40)) }).toThrow('must resolve')
  expect(() =>{  verifyPinnedBaseline(root, '--help', baseline) }).toThrow('release tag')
  expect(() =>{  verifyPinnedBaseline(root, tag, baseline.slice(0, 7)) }).toThrow('full commit ID')
  git('tag', '-d', tag)
  git('tag', '-a', tag, '-m', 'official release', baseline)
  expect(() =>{  verifyPinnedBaseline(root, tag, baseline) }).not.toThrow()
})

it('checks complete registered differences and rejects new, changed, and reverted patches', () => {
  const { root, baseline } = fixture()
  writeFileSync(join(root, 'apps/host/src/index.ts'), 'export const version = 2\n')
  const files = inventory(root, baseline)
  mkdirSync(join(root, 'scripts/upstream-patches'), { recursive: true })
  writeFileSync(join(root, 'scripts/upstream-patches/generic.patch'), completeDiff(root, baseline, files.map(item => item.path)))
  const manifest = { baseline, patches: [{ id: 'generic', purpose: 'Expose a generic revision', tests: ['test.ts'], files, diff: 'generic.patch' }] }
  expect(() =>{  verifyPatches(root, baseline, manifest) }).not.toThrow()
  writeFileSync(join(root, 'apps/host/src/new.ts'), 'export const business = true\n')
  expect(() =>{  verifyPatches(root, baseline, manifest) }).toThrow('Unregistered official changes')
  rmSync(join(root, 'apps/host/src/new.ts'))
  writeFileSync(join(root, 'apps/host/src/index.ts'), 'export const version = 3\n')
  expect(() =>{  verifyPatches(root, baseline, manifest) }).toThrow('reviewed content')
  writeFileSync(join(root, 'apps/host/src/index.ts'), 'export const version = 1\n')
  expect(() =>{  verifyPatches(root, baseline, manifest) }).toThrow('reviewed content')
  expect(() =>{  verifyPatches(root, 'different', manifest) }).toThrow('baseline')
})

it('keeps patch identities stable across Git abbreviation settings and history sizes', () => {
  const { root, baseline } = fixture()
  const path = 'apps/host/src/index.ts'
  writeFileSync(join(root, path), 'export const version = 2\n')
  execFileSync('git', ['config', 'core.abbrev', '7'], { cwd: root })
  const diff = completeDiff(root, baseline, [path])
  expect(diff).toMatch(/index [a-f0-9]{40}\.\.[a-f0-9]{40} 100644/)
  execFileSync('git', ['config', 'core.abbrev', '12'], { cwd: root })
  expect(completeDiff(root, baseline, [path])).toBe(diff)
})

it('preserves patch context whitespace while rejecting whitespace in authored source', () => {
  const { root } = fixture()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const source = join(root, 'apps/host/src/index.ts')
  writeFileSync(source, 'export const version = 1\n\nexport const other = true\n')
  git('add', '.')
  git('commit', '-qm', 'blank context')
  const baseline = git('rev-parse', 'HEAD').trim()
  writeFileSync(source, 'export const version = 2\n\nexport const other = true\n')
  const patch = completeDiff(root, baseline, ['apps/host/src/index.ts'])
  expect(patch).toContain('\n \n')
  mkdirSync(join(root, 'scripts/upstream-patches'), { recursive: true })
  writeFileSync(join(root, 'scripts/upstream-patches/generic.patch'), patch)
  writeFileSync(join(root, '.gitattributes'), readFileSync(new URL('../.gitattributes', import.meta.url)))
  git('add', '.')
  expect(() => git('diff', '--cached', '--check')).not.toThrow()
  writeFileSync(source, 'export const version = 2 \n\nexport const other = true\n')
  git('add', 'apps/host/src/index.ts')
  expect(() => git('diff', '--cached', '--check')).toThrow()
})

it('discovers imports, reexports, dynamic imports, type imports, require, and Loader module URLs', () => {
  expect(importSpecifiers('fixture.ts', `
    import A from 'one'; export { B } from 'two';
    type C = import('three').C; const d = import('four');
    const e = require('five'); const f = import.meta.resolve('six');
    // import fake from 'comment'
  `)).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
})

it('keeps Unicode paths and new-file diffs stable when changes are staged', () => {
  const { root, baseline } = fixture()
  const path = 'apps/host/src/说明.ts'
  writeFileSync(join(root, path), 'export const description = 1\n')
  const files = inventory(root, baseline)
  expect(files.map(item => item.path)).toEqual([path])
  const diff = completeDiff(root, baseline, [path])
  execFileSync('git', ['add', '.'], { cwd: root })
  expect(inventory(root, baseline)).toEqual(files)
  expect(completeDiff(root, baseline, [path])).toBe(diff)
  execFileSync('git', ['commit', '-qm', 'fork addition'], { cwd: root })
  rmSync(join(root, path))
  expect(inventory(root, baseline)).toEqual([])
})

it('compares new upstream files against the pin without changing the user index', () => {
  const { root, baseline: old } = fixture()
  const path = 'apps/host/src/upstream.ts'
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  writeFileSync(join(root, path), 'export const upstream = 1\n')
  git('add', path)
  git('commit', '-qm', 'new upstream release')
  const baseline = git('rev-parse', 'HEAD').trim()
  git('read-tree', old)
  expect(inventory(root, baseline)).toEqual([])
  writeFileSync(join(root, path), 'export const upstream = 2\n')
  const indexBefore = git('diff', '--cached', '--binary')
  const files = inventory(root, baseline)
  expect(files.map(item => item.path)).toEqual([path])
  const diff = completeDiff(root, baseline, [path])
  expect(diff).toContain('-export const upstream = 1')
  expect(diff).toContain('+export const upstream = 2')
  expect(diff).not.toContain('new file mode')
  expect(git('diff', '--cached', '--binary')).toBe(indexBefore)
  git('add', path)
  expect(inventory(root, baseline)).toEqual(files)
  expect(completeDiff(root, baseline, [path])).toBe(diff)
})

it.skipIf(process.platform === 'win32')('includes executable changes in complete patches', () => {
  const { root, baseline } = fixture()
  const path = 'apps/host/src/index.ts'
  chmodSync(join(root, path), 0o755)
  expect(inventory(root, baseline).map(item => item.path)).toEqual([path])
  expect(completeDiff(root, baseline, [path])).toContain('old mode 100644\nnew mode 100755')
})

it('includes dangling symlinks in complete patches', () => {
  const { root, baseline } = fixture()
  symlinkSync('missing-target', join(root, 'link'))
  expect(inventory(root, baseline).map(item => item.path)).toEqual(['link'])
  const diff = completeDiff(root, baseline, ['link'])
  expect(diff).toContain('new file mode 120000')
  expect(diff).toContain('+missing-target')
})

it('admits explicit public exports and rejects private paths', () => {
  const manifest = { exports: { '.': './lib/index.js', './client': './lib/client.js', './types/*': './lib/types/*.js' } }
  for (const value of ['@deepseek-ai/dsh-one', '@deepseek-ai/dsh-one/client', '@deepseek-ai/dsh-one/types/task']) {
    expect(() =>{  assertPublicImport(value, manifest) }).not.toThrow()
  }
  for (const value of ['@deepseek-ai/dsh-one/src/internal.ts', '@deepseek-ai/dsh-one/lib/private.js']) {
    expect(() =>{  assertPublicImport(value, manifest) }).toThrow('Private Harness import')
  }
})

it('rejects official dependencies on product packages and private product imports', () => {
  const { root } = fixture()
  writeFileSync(join(root, 'apps/host/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-host', dependencies: { '@deepseek-harness/product': '*' } }))
  expect(() =>{  verifyDependencies(root) }).toThrow('Official package depends on product')
  writeFileSync(join(root, 'apps/host/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-host', exports: { '.': './lib/index.js' } }))
  mkdirSync(join(root, 'packages/deepseek-harness-product/runtime/src'), { recursive: true })
  writeFileSync(join(root, 'packages/deepseek-harness-product/runtime/src/index.ts'), "import '@deepseek-ai/dsh-host/src/private.ts'\n")
  expect(() =>{  verifyDependencies(root) }).toThrow('Private Harness import')
  writeFileSync(join(root, 'packages/deepseek-harness-product/runtime/src/index.ts'), "import '../../../../apps/host/src/index.ts'\n")
  expect(() =>{  verifyDependencies(root) }).toThrow('private source')
  writeFileSync(join(root, 'packages/deepseek-harness-product/runtime/src/index.ts'), "import '@deepseek-ai/dsh-host'\n")
  expect(() =>{  verifyDependencies(root) }).not.toThrow()
  writeFileSync(join(root, 'packages/deepseek-harness-product/runtime/src/index.ts'), "import './local.ts'\n")
  expect(() =>{  verifyDependencies(root) }).not.toThrow()
})
