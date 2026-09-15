import { afterEach, describe, expect, it, vi } from 'vitest'
import { availableModels, loadSelectedModel, modelDisplayName, resolveSelectedModel, saveSelectedModel } from './modelSelection'

afterEach(() => vi.unstubAllGlobals())

describe('model selection', () => {
  it('restores only a model still published by the company', () => {
    expect(resolveSelectedModel(['model-a', 'model-b'], 'model-b')).toBe('model-b')
    expect(resolveSelectedModel(['model-a'], 'retired-model')).toBe('model-a')
    expect(resolveSelectedModel([], 'retired-model')).toBe('')
  })

  it('hides the bare 5.6 route while retaining named variants', () => {
    expect(availableModels(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.5', 'GPT-5.6'])).toEqual(['gpt-5.6-sol', 'gpt-5.5'])
    expect(resolveSelectedModel(['gpt-5.6', 'gpt-5.6-sol'], 'gpt-5.6')).toBe('gpt-5.6-sol')
  })

  it('renders model ids without inventing product tiers', () => {
    expect(modelDisplayName('deepseek-v4-flash')).toBe('Deepseek V4 Flash')
    expect(modelDisplayName('gpt-5.6-sol')).toBe('GPT 5.6 Sol')
    expect(modelDisplayName('gpt-6-astra')).toBe('GPT 6 Astra')
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
