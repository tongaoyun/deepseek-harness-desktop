import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

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

describe('Xiaoyin Electron workflows', () => {
  it('uses only available internal runners and actions', () => {
    const expected = new Map([
      ['electron-ci.yml', 'ci-node'],
      ['electron-windows.yml', 'windows-x64'],
      ['electron-macos.yml', 'macos-arm64'],
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

  it('fetches the pinned upstream tag before verifying its commit', () => {
    const steps = workflow('electron-ci.yml').jobs.desktop?.steps ?? []
    const fetch = steps.find(step => step.name === 'Fetch pinned Harness upstream')?.run ?? ''
    expect(fetch).toContain('git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git')
    expect(fetch).toContain('git fetch --force --depth=1 origin refs/tags/dsh-v0.1.7-rc.2:refs/tags/dsh-v0.1.7-rc.2')
    expect(steps.indexOf(steps.find(step => step.name === 'Fetch pinned Harness upstream')!))
      .toBeLessThan(steps.findIndex(step => step.name === 'Verify upstream and product contracts'))
  })

  it('builds the native sidecar before packaging both desktop platforms', () => {
    for (const [name, jobName] of [['electron-windows.yml', 'windows'], ['electron-macos.yml', 'macos']] as const) {
      const steps = workflow(name).jobs[jobName]?.steps ?? []
      const native = steps.find(step => step.name === 'Build Xiaoyin native sidecar')
      const packaging = steps.findIndex(step => step.name?.startsWith('Package '))
      expect(native?.run).toContain('cargo test')
      expect(native?.run).toContain('cargo build --release')
      expect(steps.indexOf(native!)).toBeLessThan(packaging)
    }
  })

  it('caches locked Windows runtime assets before the package-owned preparation', () => {
    const steps = workflow('electron-windows.yml').jobs.windows?.steps ?? []
    const assets = steps.find(step => step.name === 'Cache locked primary runtime assets')
    const packaging = steps.findIndex(step => step.name === 'Package Windows')
    const cacheScript = readFileSync(resolve(import.meta.dirname, '..', 'apps', 'desktop', 'scripts', 'prepare-windows-runtime-cache.ps1'), 'utf8')
    expect(assets?.run).toContain('prepare-windows-runtime-cache.ps1')
    expect(cacheScript).toContain('C:\\xiaoyin-desktop-builder\\runtime-downloads')
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

  it('keeps unsigned Windows acceptance artifacts separate from formal releases', () => {
    const steps = workflow('electron-windows.yml').jobs.windows?.steps ?? []
    const prepare = steps.find(step => step.name === 'Prepare package configuration')?.run ?? ''
    const packaging = steps.find(step => step.name === 'Package Windows')?.run ?? ''
    const upload = steps.find(step => step.name === 'Upload Windows artifacts')
    expect(prepare).toContain('C:\\xiaoyin-builder\\release\\electron\\.env.windows')
    expect(prepare).toContain('-Encoding UTF8')
    expect(prepare).not.toContain('utf8NoBOM')
    expect(packaging).toContain('package:desktop:win:x64:unsigned')
    expect(packaging).toContain('package:desktop:win:x64')
    expect(upload?.with?.path).toContain('.desktop-build/targets/win-x64/unsigned-artifacts/**')
  })
})
