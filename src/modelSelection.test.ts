import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSelectedModel, modelDisplayName, resolveSelectedModel, saveSelectedModel } from './modelSelection'

afterEach(() => vi.unstubAllGlobals())

describe('model selection', () => {
  it('restores only a model still published by the company', () => {
    expect(resolveSelectedModel(['model-a', 'model-b'], 'model-b')).toBe('model-b')
    expect(resolveSelectedModel(['model-a'], 'retired-model')).toBe('model-a')
    expect(resolveSelectedModel([], 'retired-model')).toBe('')
  })

  it('renders model ids without inventing product tiers', () => {
    expect(modelDisplayName('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
  })

  it('keeps model selection usable when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    })
    expect(loadSelectedModel('employee')).toBeNull()
    expect(saveSelectedModel('employee', 'model-b')).toBe(false)
  })
})
