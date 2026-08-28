import { describe, expect, it } from 'vitest'
import { modelDisplayName, resolveSelectedModel } from './modelSelection'

describe('model selection', () => {
  it('restores only a model still published by the company', () => {
    expect(resolveSelectedModel(['model-a', 'model-b'], 'model-b')).toBe('model-b')
    expect(resolveSelectedModel(['model-a'], 'retired-model')).toBe('model-a')
  })

  it('renders model ids without inventing product tiers', () => {
    expect(modelDisplayName('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
  })
})
