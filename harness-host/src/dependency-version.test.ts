import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DeepSeekHarnessRuntime } from './runtime.js'

const require = createRequire(import.meta.url)

describe('DeepSeek Harness dependency alignment', () => {
  it('keeps every direct dsh package on the same release', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = Object.entries(packageJson.dependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
    const versions = [...new Set(dependencies.map(([, version]) => version))]
    expect(versions).toEqual(['0.1.7-rc.2'])
    expect(dependencies.every(([, version]) => version === versions[0])).toBe(true)
  })

  it('reports the installed dsh package version in runtime health', async () => {
    const manifest = require('@deepseek-ai/dsh/package.json') as { version: string }
    await expect(new DeepSeekHarnessRuntime().health()).resolves.toMatchObject({ version: manifest.version })
  })
})
