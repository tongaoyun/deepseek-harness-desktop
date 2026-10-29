import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'

export const productRoots = ['vendor/product-expert-fixtures/', 'packages/deepseek-harness-product/', 'packages/extensions/ui-deepseek-harness-product/',
  'apps/product-desktop/', 'native/deepseek-harness/', 'scripts/upstream-patches/']
const owned = new Set(['UPSTREAM_COMMIT', 'UPSTREAM_TAG', 'UPSTREAM_REPOSITORY',
  '.github/workflows/product-desktop-package.yml',
  'scripts/verify-upstream.mjs', 'scripts/upstream-boundaries.mjs', 'scripts/upstream-boundaries.spec.ts',
  'scripts/upstream-boundaries.d.mts',
  'scripts/sync-upstream.mjs',
  'scripts/deepseek-harness-electron-workflows.spec.ts', 'scripts/release/gitea-release.mjs',
  '.jscpd.json', 'scripts/verify-package-dependencies.ts',
  'packages/extensions/README.i18n.yaml', 'packages/extensions/README.md', 'packages/extensions/README.zh.md',
  'docs/deepseek-harness-electron-architecture.md', 'docs/deepseek-harness-electron-architecture.zh.md', 'docs/deepseek-harness-electron-architecture.i18n.yaml',
  'docs/subsystems/deepseek-harness-product.md', 'docs/subsystems/deepseek-harness-product.zh.md', 'docs/subsystems/deepseek-harness-product.i18n.yaml',
  'apps/web/tests/deepseek-harness-catalog.e2e.ts'])

export function productOwned(path) {
  return productRoots.some(root => path.startsWith(root)) || owned.has(path) || path.startsWith('.gitea/')
    || path.startsWith('apps/web/tests/expected/deepseek-harness-catalog/')
    || path.startsWith('docs/upgrade-guide/v0.2.0-rc.2/product-task-capabilities/')
    || path.startsWith('docs/upgrade-guide/v0.2.0-rc.2/personal-extensions/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-alpha.2/product-support/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-alpha.2/expert-kit-shortcut-instructions/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-alpha.4/product-knowledge-references/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-alpha.4/product-folder-rename/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-rc.2/product-expert-kit-selection/')
    || path.startsWith('docs/upgrade-guide/v0.2.1-rc.2/product-native-sidecar/')
    || path.startsWith('docs/upgrade-guide/v0.2.2-alpha.2/product-device-identity/')
    || path.startsWith('docs/persistence-changes/2026-10-13-product-expert-kit-instructions.')
    || path.startsWith('docs/persistence-changes/2026-10-20-retire-product-content.')
}

const git = (root, args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const list = bytes => bytes.toString().split('\0').filter(Boolean)
const digest = value => createHash('sha256').update(value).digest('hex')

/**
 * Checks a locally stored official release tag against its pinned commit without network access.
 * @param root - Repository directory.
 * @param tag - Selected official release tag.
 * @param commit - Full pinned commit ID.
 */
export function verifyPinnedBaseline(root, tag, commit) {
  if (!/^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`UPSTREAM_TAG must be a pinned DeepSeek Harness release tag, got ${tag}`)
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('UPSTREAM_COMMIT must be a full commit ID')
  let actual
  try {
    actual = git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).toString().trim()
  } catch (error) {
    throw new Error(`Stored upstream tag ${tag} is missing; fetch refs/tags/${tag} from origin`, { cause: error })
  }
  if (actual !== commit) throw new Error(`upstream tag ${tag} must resolve to ${commit}, got ${actual}`)
}

export function inventory(root, baseline) {
  const original = new Map(list(git(root, ['ls-tree', '-r', '-z', baseline]))
    .map(row => {
      const [mode, , sha] = row.slice(0, row.indexOf('\t')).split(' ')
      return [row.slice(row.indexOf('\t') + 1), { mode, sha }]
    }))
  const untracked = list(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  const differences = new Set(list(git(root, ['diff', '--name-only', '-z', baseline])))
  const changed = []
  for (const path of [...new Set([...differences, ...untracked])].sort()) {
    if (productOwned(path)) continue
    // Pre-existing compiler residue is not authored source. Authored JavaScript is still checked.
    if (!original.has(path) && /\.(?:js|d\.ts)(?:\.map)?$/.test(path)
      && existsSync(resolve(root, path.replace(/\.(?:js|d\.ts)(?:\.map)?$/, '.ts')))) continue
    const target = resolve(root, path)
    const stat = lstatSync(target, { throwIfNoEntry: false })
    const after = stat === undefined ? Buffer.alloc(0) : stat.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : readFileSync(target)
    const entry = original.get(path)
    if (entry === undefined && stat === undefined) continue
    const mode = stat === undefined ? undefined : stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644'
    if (entry !== undefined && stat !== undefined && entry.mode === mode
      && createHash('sha1').update(`blob ${after.length}\0`).update(after).digest('hex') === entry.sha) continue
    const before = entry === undefined ? Buffer.alloc(0) : git(root, ['show', entry.sha])
    changed.push({ path, before: original.has(path) ? digest(before) : null,
      after: stat === undefined ? null : digest(after) })
  }
  return changed
}

export function completeDiff(root, baseline, paths) {
  if (paths.length === 0) return ''
  const directory = mkdtempSync(join(tmpdir(), 'harness-upstream-diff-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') }
  const run = args => execFileSync('git', args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 })
  try {
    run(['read-tree', baseline])
    run(['add', '-A', '--', ...paths])
    return run(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-renames', baseline, '--', ...paths]).toString()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function importSpecifiers(path, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const imports = []
  const add = node => { if (node && ts.isStringLiteralLike(node)) imports.push(node.text) }
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || node.expression.getText(tree) === 'require' || node.expression.getText(tree) === 'import.meta.resolve')) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return imports
}

export function assertPublicImport(specifier, manifest) {
  const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  const subpath = specifier === packageName ? '.' : '.' + specifier.slice(packageName.length)
  const exports = manifest.exports
  if (exports === undefined) { if (subpath !== '.') throw new Error(`Private Harness import: ${specifier}`); return }
  const keys = typeof exports === 'string' || Object.keys(exports).every(key => !key.startsWith('.')) ? ['.'] : Object.keys(exports)
  if (!keys.some(key => key === subpath || key.includes('*') && subpath.startsWith(key.split('*')[0]) && subpath.endsWith(key.split('*')[1]))) {
    throw new Error(`Private Harness import: ${specifier}`)
  }
}

export function verifyDependencies(root) {
  const paths = list(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
  const packages = new Map()
  for (const path of paths.filter(path => path.endsWith('/package.json') && existsSync(resolve(root, path)))) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
    packages.set(manifest.name, manifest)
    if (!productOwned(path) && ['apps/', 'packages/'].some(prefix => path.startsWith(prefix))) {
      for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const dependency of Object.keys(manifest[section] ?? {})) {
          if (dependency.startsWith('@deepseek-harness/')) throw new Error(`Official package depends on product: ${path}: ${dependency}`)
        }
      }
    }
  }
  let count = 0
  for (const path of paths.filter(path => /\.[cm]?[jt]sx?$/.test(path) && path.includes('/src/') && existsSync(resolve(root, path)))) {
    count++
    for (const specifier of importSpecifiers(path, readFileSync(resolve(root, path), 'utf8'))) {
      const product = productOwned(path)
      if (!product && specifier.startsWith('@deepseek-harness/')) throw new Error(`Official source imports product: ${path}: ${specifier}`)
      if (!product) continue
      if (path.startsWith('packages/deepseek-harness-product/product/') && (specifier.startsWith('@deepseek-ai/') || specifier === 'electron')) {
        throw new Error(`Product protocol must be independent: ${path}: ${specifier}`)
      }
      if (specifier.startsWith('.')) {
        const target = resolve(root, path, '..', specifier)
        if (!productRoots.some(prefix => target.startsWith(resolve(root, prefix) + sep))) throw new Error(`Product imports private source: ${path}: ${specifier}`)
      }
      if (specifier.startsWith('@deepseek-ai/dsh')) {
        const packageName = specifier.split('/').slice(0, 2).join('/')
        const manifest = packages.get(packageName)
        if (manifest === undefined) throw new Error(`Unknown Harness package: ${specifier}`)
        assertPublicImport(specifier, manifest)
      }
    }
  }
  if (count === 0) throw new Error('Dependency scan is empty')
}

export function verifyPatches(root, baseline, manifest) {
  if (manifest.baseline !== baseline) throw new Error('Patch baseline differs from UPSTREAM_COMMIT')
  const remaining = new Map(inventory(root, baseline).map(item => [item.path, item]))
  for (const patch of manifest.patches) {
    if (!patch.purpose || !patch.tests?.length || !patch.files?.length) throw new Error(`Incomplete patch registration: ${patch.id}`)
    for (const test of patch.tests) if (!existsSync(resolve(root, test))) throw new Error(`Missing patch test: ${test}`)
    for (const item of patch.files) {
      if (JSON.stringify(remaining.get(item.path)) !== JSON.stringify(item)) throw new Error(`Patch differs from reviewed content: ${item.path}`)
      remaining.delete(item.path)
    }
    const expected = readFileSync(resolve(root, 'scripts/upstream-patches', patch.diff), 'utf8')
    if (completeDiff(root, baseline, patch.files.map(item => item.path)) !== expected) throw new Error(`Complete patch differs: ${patch.id}`)
  }
  if (remaining.size > 0) throw new Error(`Unregistered official changes: ${[...remaining.keys()].join(', ')}`)
}
