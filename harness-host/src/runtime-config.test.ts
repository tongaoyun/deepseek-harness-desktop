import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { hasAuthorizedRoots } from './runtime.js'

const harnessHostDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBinary = resolve(harnessHostDirectory, 'node_modules/.bin/dsh')
const patchPath = resolve(harnessHostDirectory, 'runtime/cordis.yml')
const dshPackagePath = resolve(harnessHostDirectory, 'node_modules/@deepseek-ai/dsh/package.json')
const hostPackage = JSON.parse(readFileSync(resolve(harnessHostDirectory, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
const installedHarness = JSON.parse(readFileSync(dshPackagePath, 'utf8')) as { version: string }
// Parse the launcher output with the same YAML dependency shipped by dsh.
const yaml = createRequire(realpathSync(dshPackagePath))('js-yaml') as {
  Type: new (tag: string, options: { kind: string; construct: (value: string) => string }) => unknown
  DEFAULT_SCHEMA: { extend: (types: unknown[]) => unknown }
  load: (value: string, options: { schema: unknown }) => unknown
}
const profileSchema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value })])
type ProfileEntry = { id: string; name?: string; disabled?: unknown; config?: Record<string, unknown> }

function composedProfile(): ProfileEntry[] {
  const dshHome = mkdtempSync(join(tmpdir(), 'xiaoyin-dsh-config-'))
  try {
    const result = spawnSync(dshBinary, ['--profile', 'sdk', '--patch', patchPath, '--dump-config'], {
      cwd: harnessHostDirectory,
      env: { ...process.env, DSH_HOME: dshHome, XIAOYIN_ALLOW_SHELL: 'true', XIAOYIN_LOCAL_FILE_ROOTS: '[]' },
      encoding: 'utf8',
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).not.toMatch(/entry ".+" not found/u)
    const parsed: unknown = yaml.load(result.stdout, { schema: profileSchema })
    expect(Array.isArray(parsed)).toBe(true)
    return parsed as ProfileEntry[]
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
}

function profileEntry(entries: ProfileEntry[], id: string): ProfileEntry {
  const matches = entries.filter((entry) => entry.id === id)
  expect(matches, `Profile plugin ${id} must appear exactly once`).toHaveLength(1)
  return matches[0]!
}

describe('Harness profile overlay', () => {
  it('keeps every official profile plugin in the direct dependency closure', () => {
    const config = readFileSync(patchPath, 'utf8')
    const names = [...config.matchAll(/name:\s*['"](@deepseek-ai\/[^'"]+)['"]/gu)].map((match) => match[1]!)
    const missing = [...new Set(names)].filter((name) => hostPackage.dependencies?.[name] === undefined)
    expect(missing).toEqual([])
    const harnessVersion = hostPackage.dependencies?.['@deepseek-ai/dsh']
    expect(harnessVersion).toBe(installedHarness.version)
    const mismatched = [...new Set(names)].filter((name) => name.startsWith('@deepseek-ai/dsh-') && hostPackage.dependencies?.[name] !== harnessVersion)
    expect(mismatched).toEqual([])
  })

  it('keeps official Session and task capabilities mounted in the composed sdk profile', () => {
    const entries = composedProfile()
    const official: Record<string, string> = {
      'session-persistence-jsonl': '@deepseek-ai/dsh-session-persistence-jsonl',
      'session-query-sqlite': '@deepseek-ai/dsh-session-query-sqlite',
      'session-projection': '@deepseek-ai/dsh-session-projection',
      'session-projection-cache': '@deepseek-ai/dsh-session-projection-cache',
      'skill-filesystem': '@deepseek-ai/dsh-skill-filesystem',
      'tool-skill': '@deepseek-ai/dsh-tool-skill',
      'tool-web': '@deepseek-ai/dsh-tool-web',
      'tool-fs': '@deepseek-ai/dsh-tool-fs',
      'tool-fs-search': '@deepseek-ai/dsh-tool-fs-search',
      'tool-present': '@deepseek-ai/dsh-tool-present',
      'session-reference': '@deepseek-ai/dsh-session-reference',
      'session-schedule': '@deepseek-ai/dsh-schedule',
    }
    for (const [id, name] of Object.entries(official)) {
      expect(profileEntry(entries, id)).toMatchObject({ name })
      expect(profileEntry(entries, id).disabled).not.toBe(true)
    }
    expect(profileEntry(entries, 'attachment-local').disabled).toBe(true)
    expect(profileEntry(entries, 'session-persistence-jsonl').config?.root).toContain("dshHomePath('sessions')")
    expect(profileEntry(entries, 'session-query-sqlite').config?.path).toContain("dshHomePath('session-query.sqlite')")
    expect(profileEntry(entries, 'settings').config?.path).toBe("dshHomePath('settings.yaml')")
    expect(profileEntry(entries, 'credentials').config?.path).toBe("dshHomePath('.credentials.yaml')")
    for (const [id, filename] of Object.entries({
      'local-attachments': 'local-attachment-store-plugin.js',
      'desktop-approval': 'desktop-approval-plugin.js',
      'session-projection-bridge': 'session-projection-plugin.js',
      'xiaoyin-product-projections': 'xiaoyin-projections-plugin.js',
    })) expect(profileEntry(entries, id).name?.endsWith(`/dist/${filename}`)).toBe(true)
  })

  it('keeps filesystem, Shell and PTC product permission boundaries in the composed profile', () => {
    const entries = composedProfile()
    const rootsPolicy = profileEntry(entries, 'tool-fs').disabled
    expect(rootsPolicy).toContain('XIAOYIN_LOCAL_FILE_ROOTS')
    expect(profileEntry(entries, 'tool-fs-search').disabled).toBe(rootsPolicy)
    expect(profileEntry(entries, 'tool-present').disabled).toBe(rootsPolicy)
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh', 'terminal', 'terminal-bash', 'terminal-pwsh', 'tool-terminal']) {
      expect(profileEntry(entries, id).disabled).toContain("XIAOYIN_ALLOW_SHELL === 'false'")
    }
    expect(profileEntry(entries, 'permission').disabled).toContain("XIAOYIN_ALLOW_SHELL === 'false'")
    expect(profileEntry(entries, 'native-shell-policy').config?.enabled).toContain('XIAOYIN_ALLOW_SHELL')
    expect(profileEntry(entries, 'tools').config?.mode).toContain('XIAOYIN_TOOLS_MODE')
    expect(profileEntry(entries, 'code-runtime').disabled).toContain('XIAOYIN_TOOLS_MODE')
    expect(profileEntry(entries, 'tool-session-query').disabled).toContain('XIAOYIN_ENABLE_SESSION_QUERY_TOOLS')
  })
})

describe('authorized filesystem surface detection', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['[]', false],
    ['[{"id":"workspace"}]', true],
    ['not-json', true],
  ])('handles %s as %s', (value, expected) => {
    expect(hasAuthorizedRoots(value)).toBe(expected)
  })
})
