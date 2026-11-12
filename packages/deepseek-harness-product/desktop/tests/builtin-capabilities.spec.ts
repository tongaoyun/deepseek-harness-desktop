/** Builtin modules are part of product assembly, never profile-installed plugins. */
import { readFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { builtinCapabilityPatches } from '../src/builtin-capabilities.ts'

it('mounts fixed Host modules and keeps their content configuration identity', () => {
  const entries = composeEntries([builtinCapabilityPatches().filter(patch => 'insert' in patch)])
  expect(entries.map(entry => entry.id)).toEqual(['agency-agents-remote', 'agency-agents', 'skills-manager'])
  expect(entries.every(entry => entry.name?.startsWith('file:'))).toBe(true)
  expect(entries.every(entry => entry.disabled === undefined)).toBe(true)
})

it('preserves ordinary delegation alongside the native Team bundle', () => {
  const delegation = ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control'].map(id => ({ id, name: `cordis:${id}`, disabled: true }))
  const entries = composeEntries([[{ insert: [...delegation, { id: 'agent-team', name: 'cordis:agent-team' }] }], builtinCapabilityPatches()])
  expect(entries.find(entry => entry.id === 'agent-team')?.config).toEqual({ defaultEnabled: true })
  expect(entries.filter(entry => entry.id.startsWith('tool-subagent'))).toEqual(delegation.map(entry => ({ ...entry, disabled: false })))
})

it.each(['experts', 'skills'])('does not advertise %s as an installable client plugin', (module) => {
  const manifest: unknown = JSON.parse(readFileSync(new URL(`../../${module}/package.json`, import.meta.url), 'utf8'))
  expect(manifest).toMatchObject({ private: true })
  expect(manifest).not.toHaveProperty('dsh')
  expect(manifest).not.toHaveProperty(['exports', './cordis.patch.yml'])
})

it('ships the builtin browser pages without Node-only require shims', () => {
  const browser = readFileSync(new URL('../../../extensions/ui-deepseek-harness-product/lib/client.js', import.meta.url), 'utf8')
  expect(browser).toContain('deepseek-harness-experts')
  expect(browser).toContain('deepseek-harness-skills')
  expect(browser).not.toMatch(/require\(["']node:/u)
})
