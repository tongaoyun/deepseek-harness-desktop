import { describe, expect, it } from 'vitest'
import { codeDiffRows } from './codeDiff'

describe('codeDiffRows', () => {
  it('keeps line numbers aligned across replacements', () => {
    const rows = codeDiffRows('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n')
    expect(rows.map((row) => row.kind)).toEqual(['context', 'removed', 'added', 'context', 'added'])
    expect(rows.find((row) => row.text === 'two')).toMatchObject({ oldLine: 2 })
    expect(rows.find((row) => row.text === 'two')?.newLine).toBeUndefined()
    expect(rows.find((row) => row.text === 'TWO')).toMatchObject({ newLine: 2 })
    expect(rows.find((row) => row.text === 'TWO')?.oldLine).toBeUndefined()
    expect(rows.at(-1)).toMatchObject({ text: 'four', newLine: 4 })
  })

  it('folds long unchanged regions', () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const rows = codeDiffRows(text, text)
    expect(rows.some((row) => row.kind === 'fold' && row.foldedLines === 12)).toBe(true)
  })
})
