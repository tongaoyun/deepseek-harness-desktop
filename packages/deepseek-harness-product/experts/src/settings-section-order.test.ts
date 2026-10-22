import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('registers experts directly in main without a duplicate settings page', () => {
  const source = readFileSync(new URL('./client/index.ts', import.meta.url), 'utf8')
  expect(source).toContain("name: 'main', key: 'deepseek-harness-experts'")
  expect(source).not.toContain("'settings.section'")
})
