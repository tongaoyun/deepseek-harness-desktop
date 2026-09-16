import { afterEach, expect, it, vi } from 'vitest'
import { loadReasoningEffort, modelReasoningEfforts, reasoningLabels, resolveReasoningEffort, saveReasoningEffort } from './modelReasoning'

afterEach(() => vi.unstubAllGlobals())
it('uses distinct Chinese labels and only exposes configured model efforts', () => {
  expect(Object.values(reasoningLabels)).toEqual(['轻度', '标准', '深度', '极深', '极致'])
  expect(modelReasoningEfforts('gpt-6-astra')).toContain('ultra')
  expect(modelReasoningEfforts('gpt-5.5')).not.toContain('ultra')
  expect(modelReasoningEfforts('unknown')).toEqual([])
  expect(resolveReasoningEffort('gpt-5.5', 'ultra')).toBe('medium')
  expect(resolveReasoningEffort('unknown', 'high')).toBeUndefined()
})
it('persists effort independently for each employee and model', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  expect(saveReasoningEffort('one', 'gpt-6-astra', 'ultra')).toBe(true)
  expect(loadReasoningEffort('one', 'gpt-6-astra')).toBe('ultra')
  expect(loadReasoningEffort('two', 'gpt-6-astra')).toBe('medium')
  expect(loadReasoningEffort('one', 'gpt-5.5')).toBe('medium')
  expect(saveReasoningEffort('one', 'gpt-5.5', 'ultra')).toBe(false)
})
it('falls back to standard when storage fails', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error() }, setItem: () => { throw new Error() } })
  expect(loadReasoningEffort('one', 'gpt-6-astra')).toBe('medium')
  expect(saveReasoningEffort('one', 'gpt-6-astra', 'high')).toBe(false)
})
