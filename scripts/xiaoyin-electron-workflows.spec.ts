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

  it('keeps unsigned Windows acceptance artifacts separate from formal releases', () => {
    const steps = workflow('electron-windows.yml').jobs.windows?.steps ?? []
    const prepare = steps.find(step => step.name === 'Prepare package configuration')?.run ?? ''
    const packaging = steps.find(step => step.name === 'Package Windows')?.run ?? ''
    const upload = steps.find(step => step.name === 'Upload Windows artifacts')
    expect(prepare).toContain('C:\\xiaoyin-builder\\release\\electron\\.env.windows')
    expect(packaging).toContain('package:desktop:win:x64:unsigned')
    expect(packaging).toContain('package:desktop:win:x64')
    expect(upload?.with?.path).toContain('.desktop-build/targets/win-x64/unsigned-artifacts/**')
  })
})
