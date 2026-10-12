/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
    expect(isRescopeExcluded('scripts/rescope-vendor.spec.ts')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('runtime identifier preservation', () => {
  it.each([
    'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx',
    'apps/web/tests/agent-preset-selection.e2e.ts',
    'packages/bundle/web-app/cordis.patch.yml',
    'docs/subsystems/schedule.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md',
  ])('preserves the preset ID in %s while checking other package names', (file) => {
    const text = 'Use `cordis` and `@cordisjs/plugin-loader`.\n'
    expect(isRescopeExcluded(file)).toBe(false)
    expect(rescopeText(text, file)).toBe('Use `cordis` and `@deepseek-ai/cordis-plugin-loader`.\n')
  })

  it('preserves Inspector event names while rewriting actual plugin imports', () => {
    const text = "ctx.on('cordis/inspect-query', handler)\nimport Loader from '@cordisjs/plugin-loader'\n"
    expect(rescopeText(text, 'snapshots/session/cordis-inspect-timeout/client-fixture.mjs'))
      .toBe("ctx.on('cordis/inspect-query', handler)\nimport Loader from '@deepseek-ai/cordis-plugin-loader'\n")
  })

  it('continues rewriting unregistered bare package imports', () => {
    expect(rescopeText("import { Context } from 'cordis'\n", 'packages/example/src/index.ts'))
      .toBe("import { Context } from '@deepseek-ai/cordis'\n")
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})
