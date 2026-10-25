import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { readDesktopAssembly } from '../apps/desktop/scripts/desktop-assembly.mjs'
import { productPackagingAssembly } from '../apps/product-desktop/scripts/packaging-assembly.mjs'

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Readonly<Record<string, string>>
  readonly with?: Readonly<Record<string, string | boolean>>
}

interface WorkflowJob {
  readonly 'runs-on': string
  readonly env?: Readonly<Record<string, string>>
  readonly steps: readonly WorkflowStep[]
}

interface Workflow {
  readonly concurrency?: { readonly group: string; readonly 'cancel-in-progress': boolean }
  readonly jobs: Record<string, WorkflowJob>
}

function workflow(name: string): Workflow {
  return yaml.load(readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', name), 'utf8')) as Workflow
}

describe('DeepSeekHarness Electron workflows', () => {
  it('keeps only internal CI and manual GitHub synchronization workflows', () => {
    const files = readdirSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows'))
      .filter(name => /\.ya?ml$/u.test(name)).sort()
    expect(files).toEqual(['electron-ci.yml', 'github-desktop-sync.yml'])
  })

  it('builds product and bundled plugin artifacts before their contract checks', () => {
    const command = workflow('electron-ci.yml').jobs.desktop?.steps
      .find(step => step.name === 'Verify upstream and product contracts')?.run ?? ''
    expect(command).toContain('pnpm run build:artifacts\n')
    for (const module of ['experts', 'skills']) {
      const check = `pnpm exec tsc --noEmit -p packages/deepseek-harness-product/${module}/tsconfig.json`
      expect(command).toContain(check)
      expect(command.indexOf('pnpm run build:artifacts\n')).toBeLessThan(command.indexOf(check))
    }
    expect(command).toContain('pnpm exec vitest run --config packages/deepseek-harness-product/experts/vitest.config.ts')
    expect(command).toContain('node --test apps/product-desktop/tests/company-content.test.mjs')
    expect(command).toContain('pnpm run typecheck\n')
    expect(command).not.toContain('pnpm run build:lib:host')
    expect(command).not.toContain('pnpm run typecheck:contracts-ready')
    const tests = command.match(/\S+\.spec\.tsx?/gu) ?? []
    for (const scope of ['packages/deepseek-harness-product', 'packages/extensions/ui-deepseek-harness-product']) {
      expect(command.split(/\s+/u)).toContain(scope)
      expect(tests.some(path => path.startsWith(`${scope}/`))).toBe(false)
    }
    for (const path of tests) expect(existsSync(resolve(import.meta.dirname, '..', path)), path).toBe(true)
  })

  it('does not couple desktop CI to a server community expert list', () => {
    const steps = workflow('electron-ci.yml').jobs.desktop!.steps
    expect(JSON.stringify(steps)).not.toMatch(/BundledExpertIds|sync-bundled-expert-ids|expert-contract/u)
  })

  it('uses only available internal runners and actions', () => {
    for (const name of ['electron-ci.yml', 'github-desktop-sync.yml']) {
      const jobs = Object.values(workflow(name).jobs)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.['runs-on']).toBe('ci-node')
      for (const step of jobs[0]?.steps ?? []) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/^http:\/\/192\.168\.2\.67:30330\/instudio\//u)
      }
    }
  })

  it('cancels stale pull-request CI runs', () => {
    expect(workflow('electron-ci.yml').concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
  })

  it('keeps the shared-runner test budget aligned with upstream CI', () => {
    const upstream = yaml.load(readFileSync(resolve(import.meta.dirname, '..', '.github/workflows/ci.yml'), 'utf8')) as Workflow
    const budget = Object.values(upstream.jobs).map(job => job.env?.DSH_COVERAGE_TEST_TIMEOUT_MS)
      .find(value => value !== undefined)
    expect(budget).toBeDefined()
    expect(workflow('electron-ci.yml').jobs.desktop?.env?.DSH_COVERAGE_TEST_TIMEOUT_MS).toBe(budget)
  })

  it('confines the mock keychain to isolated macOS UI acceptance', () => {
    const root = resolve(import.meta.dirname, '..')
    const smoke = readFileSync(resolve(root, 'apps/web/tests/deepseek-harness-catalog.e2e.ts'), 'utf8')
    expect(smoke).toContain("process.env.DSH_DESKTOP_SMOKE !== '1'")
    expect(smoke).toContain("...process.platform === 'darwin' ? ['--use-mock-keychain'] : []")
    const paths = ['apps/desktop/electron-builder.config.mjs',
      'packages/deepseek-harness-product/desktop/assembly.json']
    for (const directory of ['apps/desktop/src', 'apps/desktop/scripts', 'apps/product-desktop/scripts',
      'packages/deepseek-harness-product/desktop/src']) {
      for (const path of readdirSync(resolve(root, directory), { recursive: true })) {
        if (typeof path === 'string' && /\.(?:ts|mjs|json)$/u.test(path)) paths.push(`${directory}/${path}`)
      }
    }
    for (const path of paths) expect(readFileSync(resolve(root, path), 'utf8'), path).not.toContain('--use-mock-keychain')
  })

  it('passes product extension file URLs to the ESM loader in development and UI acceptance', () => {
    const root = resolve(import.meta.dirname, '..')
    const development = readFileSync(resolve(root, 'apps/product-desktop/scripts/dev.ts'), 'utf8')
    expect(development).toContain("pathToFileURL(require.resolve('@deepseek-harness/product-desktop')).href")
    const smoke = readFileSync(resolve(root, 'apps/web/tests/deepseek-harness-catalog.e2e.ts'), 'utf8')
    expect(smoke).toContain("DSH_DESKTOP_EXTENSION: pathToFileURL(join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/lib/index.js')).href")
    expect(smoke).toContain('DSH_DESKTOP_DIAGNOSTIC_FILE: startupDiagnostic')
    expect(smoke).toContain("if (task.result?.state !== 'fail') return")
    const hosted = readFileSync(resolve(root, '.github/workflows/product-desktop-package.yml'), 'utf8')
    expect(hosted).toContain('.artifacts/deepseek-harness-catalog/electron-*-startup.txt')
  })

  it('uses the reachable npm registry instead of the unavailable internal mirror', () => {
    for (const name of ['electron-ci.yml', 'github-desktop-sync.yml']) {
      const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', name), 'utf8')
      expect(source).toContain('https://registry.npmjs.org/')
      expect(source).not.toContain('192.168.2.9:4873')
    }
  })

  it('limits the existing authenticated proxy to dependency installation and GitHub synchronization', () => {
    for (const name of ['electron-ci.yml', 'github-desktop-sync.yml']) {
      const steps = Object.values(workflow(name).jobs)[0]!.steps
      const install = steps.find(step => step.name === (name === 'electron-ci.yml' ? 'Install dependencies' : 'Install locked dependencies'))!
      expect(install.env).toEqual({ HTTPS_PROXY: '${{ secrets.DESKTOP_GITHUB_PROXY_URL }}', NODE_USE_ENV_PROXY: '1' })
      expect(steps.filter(step => step.env?.HTTPS_PROXY !== undefined).map(step => step.name))
        .toEqual(name === 'electron-ci.yml' ? ['Install dependencies'] : ['Install locked dependencies', 'Verify source and synchronize'])
    }
  })

  it('fetches the pinned baseline from the desktop repository before verifying its commit', () => {
    const steps = workflow('electron-ci.yml').jobs.desktop?.steps ?? []
    const fetch = steps.find(step => step.name === 'Fetch stored Harness baseline')?.run ?? ''
    expect(fetch).toContain('UPSTREAM_TAG="$(cat UPSTREAM_TAG)"')
    expect(fetch).toContain('for attempt in 1 2 3')
    expect(fetch).toContain('timeout 120 git -c http.version=HTTP/1.1 fetch --depth=1 origin')
    expect(fetch).toContain('if [ "$attempt" -eq 3 ]')
    expect(fetch).toContain('"refs/tags/${UPSTREAM_TAG}:refs/tags/${UPSTREAM_TAG}"')
    expect(fetch).not.toContain('dsh-v0.1.7-rc.2')
    expect(steps.indexOf(steps.find(step => step.name === 'Fetch stored Harness baseline')!))
      .toBeLessThan(steps.findIndex(step => step.name === 'Verify upstream and product contracts'))
  })

  it('keeps baseline verification independent of GitHub and a mirror repository', () => {
    for (const name of ['electron-ci.yml', 'github-desktop-sync.yml']) {
      const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', name), 'utf8')
      expect(source).not.toContain('UPSTREAM_REPOSITORY')
      expect(source).not.toContain('UPSTREAM_MIRROR_REPOSITORY')
      expect(source).not.toContain('git remote add upstream')
      expect(source).not.toContain('--force')
      for (const job of Object.values(workflow(name).jobs)) {
        const fetch = job.steps.findIndex(step => step.name === 'Fetch stored Harness baseline')
        const install = job.steps.findIndex(step => step.name?.startsWith('Install '))
        const verify = job.steps.findIndex(step => (step.run ?? '').includes('pnpm run verify:upstream'))
        expect(fetch).toBeGreaterThanOrEqual(0)
        expect(fetch).toBeLessThan(install)
        expect(install).toBeLessThan(verify)
      }
    }
  })

  it('packages product resources through the application-owned assembly entry', () => {
    const entry = readFileSync(resolve(import.meta.dirname, '..', 'apps/product-desktop/scripts/package.ts'), 'utf8')
    expect(entry).toContain('DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest')
    expect(entry).toContain('packages/deepseek-harness-product/desktop/assembly.json')
    const manifest = resolve(import.meta.dirname, '..', 'packages/deepseek-harness-product/desktop/assembly.json')
    const assembly = readDesktopAssembly({ DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest }, 'win32')
    expect(assembly.runtimePackages).toContain('@deepseek-harness/product-desktop')
    expect(assembly.resources.map(resource => resource.to)).toEqual(expect.arrayContaining([
      'desktop-extension.json', 'deepseek-harness/product.json', 'native/deepseek-harness-native.exe',
    ]))
    expect(assembly.resources.some(resource => resource.to === 'native/deepseek-harness-native')).toBe(false)
  })

  it('uses Cargo target paths while preserving relocated product resource and package paths', () => {
    const manifest = resolve(import.meta.dirname, '..', 'packages/deepseek-harness-product/desktop/assembly.json')
    const original = readDesktopAssembly({ DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest }, 'win32')
    const target = resolve(import.meta.dirname, 'cargo-cache')
    const prepared = productPackagingAssembly(manifest, target)
    expect(prepared.resources.find(resource => resource.to === 'native/deepseek-harness-native.exe')?.from)
      .toBe(resolve(target, 'release/deepseek-harness-native.exe'))
    expect(prepared.resources.find(resource => resource.to === 'native/deepseek-harness-native')?.from)
      .toBe(resolve(target, 'release/deepseek-harness-native'))
    expect(prepared.resources.find(resource => resource.to === 'desktop-extension.json')?.from)
      .toBe(original.resources.find(resource => resource.to === 'desktop-extension.json')?.from)
    expect(prepared.packageDirectories).toEqual(original.packageDirectories)
    expect(prepared.icons).toEqual(original.icons)
    const entry = readFileSync(resolve(import.meta.dirname, '..', 'apps/product-desktop/scripts/package.ts'), 'utf8')
    expect(entry).toContain("'metadata', '--format-version', '1', '--no-deps'")
    expect(entry).toContain('if (!existsSync(binary)) throw')
    expect(entry.indexOf('if (!existsSync(binary)) throw')).toBeLessThan(entry.indexOf('const child = spawn'))
  })

  it('keeps locked Windows runtime cache preparation available for local packaging', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'apps/desktop/scripts/prepare-windows-runtime-cache.ps1'), 'utf8')
    expect(source).toContain('C:\\deepseek-harness-desktop-builder\\runtime-downloads')
    expect(source).toContain('New-Item -ItemType Junction')
    expect(source).toContain('[IO.Directory]::Delete($DownloadCache)')
    expect(source).toContain('scripts\\primary-runtime\\lock.json')
    expect(source).toContain('Get-FileHash')
    expect(source).toContain('[IO.FileShare]::None')
    expect(source).toContain("[Guid]::NewGuid().ToString('N')")
    expect(source).toContain('[IO.File]::Move($Temporary, $Destination)')
    expect(source).not.toContain('[IO.File]::Move($Temporary, $Destination, $true)')
    expect(source).toContain('$Lock.Dispose()')
    expect(source).toContain('cdn.npmmirror.com/binaries/node')
    expect(source).toContain('ghfast.top/https://github.com/astral-sh/python-build-standalone')
    expect(source).toContain('mirrors.aliyun.com/pypi')
    expect(source).toContain('curl.exe -fL -C - --retry 4 --retry-all-errors')
  })

  it('makes Gitea release uploads idempotent and memory bounded', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'scripts/release/gitea-release.mjs'), 'utf8')
    expect(source).toContain('createReadStream(file.path)')
    expect(source).toContain('bodyFactory')
    expect(source).toContain('await backoff(attempt)')
    expect(source).toContain('GITEA_RELEASE_REPLACE_ASSETS')
    expect(source).toContain('reconciled ${asset.name} after an interrupted upload')
    expect(source).toContain('await deleteAsset(releaseId, existing.id)')
    expect(source).not.toContain('await readFile(file.path)')
  })
})
