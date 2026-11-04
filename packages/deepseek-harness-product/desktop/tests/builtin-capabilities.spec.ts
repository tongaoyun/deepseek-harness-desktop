/** Builtin modules are part of product assembly, never profile-installed plugins. */
import { readFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { builtinCapabilityPatches } from '../src/builtin-capabilities.ts'

it('mounts fixed Host modules and keeps their content configuration identity', () => {
  const entries = composeEntries([builtinCapabilityPatches()])
  expect(entries.map(entry => entry.id)).toEqual(['agent-team', 'tool-agent-team', 'ui-agent-team', 'agency-agents-remote', 'agency-agents', 'skills-manager'])
  expect(entries.every(entry => entry.name?.startsWith('file:'))).toBe(true)
  expect(entries.every(entry => entry.disabled === undefined)).toBe(true)
})

it('preserves an explicit native Team opt-out without removing ordinary delegation', () => {
  const delegation = ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control'].map(id => ({ id, name: `cordis:${id}` }))
  const entries = composeEntries([[{ insert: delegation }], builtinCapabilityPatches(), [{ id: 'agent-team', disabled: true }]])
  expect(entries.find(entry => entry.id === 'agent-team')?.disabled).toBe(true)
  expect(entries.filter(entry => entry.id.startsWith('tool-subagent'))).toEqual(delegation)
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
