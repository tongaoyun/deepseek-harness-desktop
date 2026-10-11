import { expect, it } from 'vitest'
import { inferenceProfile } from '../src/inference-profile.ts'

it('uses exact server model IDs and credential references in official adapter overlays', () => {
  const rows = inferenceProfile({ modelApiKey: 'private-model-secret', endpoints: { litellm: 'https://models.test/v1' },
    models: ['deepseek-v4-flash', 'gpt-example'] }, 'file:///product/inference-default.js')
  expect(rows[0]).toMatchObject({ id: 'llm-deepseek', config: { models: [{ id: 'deepseek-v4-flash' }] } })
  expect(rows[2]).toMatchObject({ config: { providers: { 'product-gateway': {
    api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'gpt-example' }],
  } } } })
  expect(JSON.stringify(rows)).not.toContain('private-model-secret')
  expect(JSON.stringify(rows)).not.toContain('deepseek-flash')
})

it('keeps the product profile on DingTalk authentication when a saved Desktop patch is stale', () => {
  const rows = inferenceProfile({ modelApiKey: 'private-model-secret', endpoints: { litellm: 'https://models.test/v1' },
    models: ['deepseek-v4-flash'] }, 'file:///product/inference-default.js')
  expect(rows).toEqual(expect.arrayContaining([
    { id: 'ui-settings-account', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
  ]))
})

it('does not advertise the public DeepSeek adapter when the server only supplies other models', () => {
  const rows = inferenceProfile({ modelApiKey: 'private', endpoints: { litellm: 'https://models.test/v1' },
    models: ['gpt-example'] }, 'file:///product/inference-default.js')
  expect(rows[0]).toMatchObject({ disabled: true })
})
