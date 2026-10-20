/** Plugin substitution retains native profile settings and uses the Include mount semantics. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot } from '../src/index.ts'

it('replaces only the plugin specifier and keeps the input list detached', () => {
  const rows = [{ id: 'plugin', name: 'old-plugin', disabled: true, config: { enabled: ['mine'] } }]
  const warn = vi.fn()
  const patched = applyEntryPatches(rows, [{ id: 'plugin', name: 'old-plugin', replace: 'bundled-plugin' }], warn)
  expect(patched).toEqual([{ ...rows[0], name: 'bundled-plugin' }])
  expect(rows[0]?.name).toBe('old-plugin')
  expect(warn).not.toHaveBeenCalled()
  expect(applyEntryPatches(rows, [{ id: 'plugin', name: 'other-plugin', replace: 'bundled-plugin' }], warn)).toEqual(rows)
  expect(warn).toHaveBeenCalledOnce()
})

it.each(['', '  '])('rejects an empty replacement %j before plugin activation', (replace) => {
  expect(() => applyEntryPatches([{ id: 'plugin', name: 'original' }], [{ id: 'plugin', replace }], vi.fn())).toThrow('nonempty plugin name')
})

it('rejects replacing a group with a plugin', () => {
  expect(() => applyEntryPatches([{ id: 'group', name: 'cordis:group', group: true, config: [] }], [{ id: 'group', replace: 'plugin' }], vi.fn())).toThrow('cannot be a group')
})

it('mounts the replacement once through the real file-backed Loader without importing the original', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-replacement-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const original = join(directory, 'old.mjs')
  const replacement = join(directory, 'bundled.mjs')
  writeFileSync(original, 'throw new Error("original plugin must not load")\n')
  writeFileSync(replacement, 'export function apply(ctx, config) { ctx.provide("replacementValue", config.value) }\n')
  writeFileSync(join(directory, 'cordis.yml'), JSON.stringify([{ id: 'employee-plugin', name: pathToFileURL(original).href, config: { value: 'retained' } }]))
  const ctx = await boot('replacement-test', join(directory, 'cordis.yml'), [{ id: 'employee-plugin', name: pathToFileURL(original).href, replace: pathToFileURL(replacement).href }])
  onTestFinished(() => ctx.fiber.dispose())
  expect(ctx.get('replacementValue')).toBe('retained')
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.id === 'employee-plugin')
  expect(entries).toHaveLength(1)
  expect(entries[0]?.options.name).toBe(pathToFileURL(replacement).href)
})
