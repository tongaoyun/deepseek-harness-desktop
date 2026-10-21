import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeEntries, initProfile } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import { nativeExtensionPatches } from '../src/native-extensions.ts'

function fixture(entries: object[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'native-extensions-'))
  onTestFinished(() =>{  rmSync(directory, { recursive: true, force: true }) })
  initProfile(directory, [])
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: entries }]))
  return { directory, installAnchor: new URL('../package.json', import.meta.url).pathname }
}

it('preinstalls agents and skills through official profile entries without product execution presets', () => {
  const patch = nativeExtensionPatches(fixture())
  const entries = composeEntries([patch])
  expect(entries.map(entry => entry.id)).toEqual(['agency-agents-remote', 'agency-agents', 'skills-manager'])
  expect(entries.every(entry => entry.name?.startsWith('file:'))).toBe(true)
})

it('preserves an existing disabled plugin and its configuration under a custom ID', () => {
  const profile = fixture([{ id: 'employee-skills', name: '@michengai/dsh-skills-manager', disabled: true, config: { root: 'employee' } }])
  const patch = nativeExtensionPatches(profile)
  const entries = composeEntries([[{ insert: [{ id: 'employee-skills', name: '@michengai/dsh-skills-manager', disabled: true, config: { root: 'employee' } }] }], patch])
  expect(entries.filter(entry => entry.id === 'employee-skills')).toEqual([
    { id: 'employee-skills', name: import.meta.resolve('@michengai/dsh-skills-manager'), disabled: true, config: { root: 'employee' } },
  ])
  expect(entries.some(entry => entry.id === 'skills-manager')).toBe(false)
})

it('rejects occupied IDs and duplicate plugin entries before launching the Host', () => {
  expect(() => nativeExtensionPatches(fixture([{ id: 'skills-manager', name: 'different-plugin' }]))).toThrow('occupied')
  expect(() => nativeExtensionPatches(fixture([
    { id: 'one', name: '@michengai/dsh-skills-manager' }, { id: 'two', name: '@michengai/dsh-skills-manager' },
  ]))).toThrow('Duplicate')
})
