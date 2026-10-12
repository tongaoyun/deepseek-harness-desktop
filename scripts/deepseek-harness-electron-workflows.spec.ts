import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { readDesktopAssembly } from '../apps/desktop/scripts/desktop-assembly.mjs'
import { productPackagingAssembly } from '../apps/product-desktop/scripts/packaging-assembly.mjs'

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly 'runs-on': string
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
  it('runs existing product contract tests after the Host extraction', () => {
    const command = workflow('electron-ci.yml').jobs.desktop?.steps
      .find(step => step.name === 'Verify upstream and product contracts')?.run ?? ''
    const tests = command.match(/\S+\.spec\.tsx?/gu) ?? []
    expect(tests).toContain('packages/deepseek-harness-product/runtime/tests/deepseek-harness-connector-contract.spec.ts')
    expect(tests).toContain('packages/deepseek-harness-product/runtime/tests/deepseek-harness-runtime.spec.ts')
    for (const path of tests) expect(existsSync(resolve(import.meta.dirname, '..', path)), path).toBe(true)
  })

  it('uses only available internal runners and actions', () => {
    const expected = new Map([
      ['electron-ci.yml', 'ci-node'],
      ['electron-windows.yml', 'windows-x64'],
      ['electron-macos.yml', 'macos-arm64'],
      ['upstream-release-check.yml', 'ci-node'],
    ])
    for (const [name, runner] of expected) {
      const jobs = Object.values(workflow(name).jobs)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.['runs-on']).toBe(runner)
      for (const step of jobs[0]?.steps ?? []) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/^http:\/\/192\.168\.2\.66:3300\/instudio\//u)
      }
    }
  })

  it('cancels stale pull-request CI and Windows packaging runs', () => {
    for (const name of ['electron-ci.yml', 'electron-windows.yml']) {
      expect(workflow(name).concurrency).toEqual({
        group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
        'cancel-in-progress': true,
      })
    }
  })

  it('uses the reachable npm registry instead of the unavailable internal mirror', () => {
    for (const name of ['electron-ci.yml', 'electron-windows.yml', 'electron-macos.yml']) {
      const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', name), 'utf8')
      expect(source).toContain('https://registry.npmjs.org/')
      expect(source).not.toContain('192.168.2.9:4873')
    }
  })

  it('downloads the Windows Electron runtime from the reachable binary mirror', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', 'electron-windows.yml'), 'utf8')
    expect(source).toContain('NPM_CONFIG_ELECTRON_MIRROR: https://cdn.npmmirror.com/binaries/electron/')
  })

  it('materializes the Windows application runtime from the reachable npm mirror', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', 'electron-windows.yml'), 'utf8')
    expect(source).toContain('DSH_DESKTOP_NPM_REGISTRY: https://registry.npmmirror.com/')
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

  it('keeps CI and release baseline verification independent of GitHub and a mirror repository', () => {
    for (const name of ['electron-ci.yml', 'electron-release.yml']) {
      const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', name), 'utf8')
      expect(source).not.toContain('UPSTREAM_REPOSITORY')
      expect(source).not.toContain('UPSTREAM_MIRROR_REPOSITORY')
      expect(source).not.toContain('git remote add upstream')
      expect(source).not.toContain('--force')
      for (const job of Object.values(workflow(name).jobs)) {
        const fetch = job.steps.findIndex(step => step.name === 'Fetch stored Harness baseline')
        const install = job.steps.findIndex(step => step.name === 'Install dependencies')
        const verify = job.steps.findIndex(step => (step.run ?? '').includes('verify-upstream.mjs')
          || (step.run ?? '').includes('pnpm run verify:upstream'))
        expect(fetch).toBeGreaterThanOrEqual(0)
        expect(fetch).toBeLessThan(install)
        expect(install).toBeLessThan(verify)
      }
    }
  })

  it('reports new upstream RC or stable tags without changing the pin', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', 'upstream-release-check.yml'), 'utf8')
    const steps = workflow('upstream-release-check.yml').jobs.check?.steps ?? []
    expect(source).toContain('schedule:')
    expect(steps.find(step => step.name === 'Check release selection')?.run)
      .toContain('node scripts/check-upstream-release.mjs --fail-on-update')
    expect(source).not.toContain('sync-upstream.mjs')
    expect(source).not.toContain('git push')
  })

  it('builds the native sidecar before packaging both desktop platforms', () => {
    for (const [name, jobName] of [['electron-windows.yml', 'windows'], ['electron-macos.yml', 'macos']] as const) {
      const steps = workflow(name).jobs[jobName]?.steps ?? []
      const native = steps.find(step => step.name === 'Build DeepSeek Harness native sidecar')
      const packaging = steps.findIndex(step => step.name?.startsWith('Package '))
      expect(native?.run).toContain('cargo test')
      expect(native?.run).toContain('cargo build --release')
      expect(steps.indexOf(native!)).toBeLessThan(packaging)
    }
  })

  it('packages product resources through the application-owned assembly entry', () => {
    for (const [file, jobName, stepName, target] of [
      ['electron-windows.yml', 'windows', 'Package Windows', 'win-x64 --unsigned'],
      ['electron-macos.yml', 'macos', 'Package macOS', 'mac-arm64'],
      ['electron-release.yml', 'windows', 'Package Windows unsigned', 'win-x64 --unsigned'],
      ['electron-release.yml', 'macos', 'Package macOS', 'mac-arm64'],
    ] as const) {
      const command = workflow(file).jobs[jobName]?.steps.find(step => step.name === stepName)?.run ?? ''
      expect(command).toContain(`pnpm --dir apps/product-desktop run package ${target}`)
    }
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

  it('caches locked Windows runtime assets before the package-owned preparation', () => {
    const steps = workflow('electron-windows.yml').jobs.windows?.steps ?? []
    const assets = steps.find(step => step.name === 'Cache locked primary runtime assets')
    const packaging = steps.findIndex(step => step.name === 'Package Windows')
    const cacheScript = readFileSync(resolve(import.meta.dirname, '..', 'apps', 'desktop', 'scripts', 'prepare-windows-runtime-cache.ps1'), 'utf8')
    expect(assets?.run).toContain('prepare-windows-runtime-cache.ps1')
    expect(cacheScript).toContain('C:\\deepseek-harness-desktop-builder\\runtime-downloads')
    expect(cacheScript).toContain('New-Item -ItemType Junction')
    expect(cacheScript).toContain('[IO.Directory]::Delete($DownloadCache)')
    expect(cacheScript).toContain('scripts\\primary-runtime\\lock.json')
    expect(cacheScript).toContain('Get-FileHash')
    expect(cacheScript).toContain('[IO.FileShare]::None')
    expect(cacheScript).toContain("[Guid]::NewGuid().ToString('N')")
    expect(cacheScript).toContain('[IO.File]::Move($Temporary, $Destination)')
    expect(cacheScript).not.toContain('[IO.File]::Move($Temporary, $Destination, $true)')
    expect(cacheScript).toContain('$Lock.Dispose()')
    expect(cacheScript).toContain('cdn.npmmirror.com/binaries/node')
    expect(cacheScript).toContain('ghfast.top/https://github.com/astral-sh/python-build-standalone')
    expect(cacheScript).toContain('mirrors.aliyun.com/pypi')
    expect(cacheScript).toContain('curl.exe -fL -C - --retry 4 --retry-all-errors')
    expect(steps.find(step => step.name === 'Prepare reusable runtime downloads')).toBeUndefined()
    expect(steps.indexOf(assets!)).toBeLessThan(packaging)
  })

  it('builds and uploads only unsigned Windows artifacts', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', 'electron-windows.yml'), 'utf8')
    const steps = workflow('electron-windows.yml').jobs.windows?.steps ?? []
    const prepare = steps.find(step => step.name === 'Prepare package configuration')?.run ?? ''
    const packaging = steps.find(step => step.name === 'Package Windows')?.run ?? ''
    const upload = steps.find(step => step.name === 'Upload Windows artifacts')
    expect(source).not.toContain('signing:')
    expect(source).not.toContain('inputs.signing')
    expect(prepare).toContain('DSH_DESKTOP_APP_ID=com.instudio.deepseek-harness.desktop')
    expect(prepare).not.toContain('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
    expect(prepare).not.toContain('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG')
    expect(prepare).not.toContain('ReleaseConfig')
    expect(prepare).not.toContain('Copy-Item')
    expect(prepare).not.toContain('DSH_DESKTOP_WINDOWS_')
    expect(prepare).toContain('-Encoding UTF8')
    expect(prepare).not.toContain('utf8NoBOM')
    expect(packaging).toContain('run package win-x64 --unsigned')
    expect(packaging).not.toMatch(/run package win-x64(?:\s*$)/u)
    expect(steps.find(step => step.name === 'Run NSIS installer and uninstaller smoke tests')?.run).toContain('test:installer')
    expect(upload?.with?.name).toContain('windows-unsigned-')
    expect(upload?.with?.path).toContain('apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/*.exe')
    expect(upload?.with?.path).toContain('apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/*.blockmap')
    expect(upload?.with?.path).not.toContain('win-x64/artifacts/')
  })

  it('uploads platform artifacts from the desktop package build directory', () => {
    const windowsSteps = workflow('electron-windows.yml').jobs.windows?.steps ?? []
    const windows = windowsSteps.find(step => step.name === 'Upload Windows artifacts')?.with?.path
    const macos = workflow('electron-macos.yml').jobs.macos?.steps
      .find(step => step.name === 'Upload macOS artifacts')?.with?.path
    const verifyWindows = windowsSteps.find(step => step.name === 'Verify Windows artifacts')?.run ?? ''
    expect(verifyWindows).toContain('win-unpacked\\resources\\native\\deepseek-harness-native.exe')
    expect(verifyWindows).toContain('Get-AuthenticodeSignature')
    expect(verifyWindows).toContain('$Signature.Status -ne "NotSigned"')
    expect(verifyWindows).toContain('Get-FileHash')
    expect(windows).toContain('apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/*.exe')
    expect(windows).not.toContain('apps/desktop/.desktop-build/targets/win-x64/artifacts/')
    expect(windows).not.toContain('win-unpacked')
    expect(windows).not.toContain('/**')
    expect(macos).toBe('apps/desktop/.desktop-build/targets/mac-arm64/artifacts/**')
  })

  it('keeps the multi-platform Release private until macOS finalization', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', '.gitea', 'workflows', 'electron-release.yml'), 'utf8')
    expect(source).toContain('GITEA_RELEASE_DRAFT: "true"')
    expect(source).toContain('GITEA_RELEASE_COMMIT: ${{ github.sha }}')
    expect(source).toContain('macos:\n    needs: windows')
    expect(source).toContain('GITEA_RELEASE_FINALIZE=true node scripts/release/gitea-release.mjs')
    expect(source).toContain('prepare-windows-runtime-cache.ps1')
    expect(source).toContain('node scripts/verify-upstream.mjs')
    expect(source).toContain('GITEA_RELEASE_DOWNLOAD_ORIGIN: http://192.168.2.66:3300')
    expect(source).not.toContain('Package macOS Intel')
    expect(source).not.toContain('package:desktop:mac:x64')
    expect(source).not.toContain('platform mac-x64')
  })

  it('makes Gitea release uploads idempotent and memory bounded', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'scripts', 'release', 'gitea-release.mjs'), 'utf8')
    expect(source).toContain('createReadStream(file.path)')
    expect(source).toContain('bodyFactory')
    expect(source).toContain('await backoff(attempt)')
    expect(source).toContain('GITEA_RELEASE_REPLACE_ASSETS')
    expect(source).toContain('reconciled ${asset.name} after an interrupted upload')
    expect(source).toContain('await deleteAsset(releaseId, existing.id)')
    expect(source).not.toContain('await readFile(file.path)')
  })
})
