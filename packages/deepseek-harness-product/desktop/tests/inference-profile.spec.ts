import { expect, it } from 'vitest'
import { inferenceProfile } from '../src/inference-profile.ts'

it('adds company routes without overwriting native API-key or user provider configuration', () => {
  const rows = inferenceProfile({ modelApiKey: 'private-model-secret', endpoints: { litellm: 'https://models.test/v1' },
    models: ['deepseek-v4-flash', 'gpt-example'] }, 'file:///product/inference-default.js')
  expect(rows).toMatchInlineSnapshot(`
    [
      {
        "disabled": true,
        "id": "llm-deepseek-account",
      },
      {
        "disabled": true,
        "id": "ui-settings-account",
      },
      {
        "insert": [
          {
            "config": {
              "baseURL": "https://models.test/v1",
              "models": [
                "deepseek-v4-flash",
                "gpt-example",
              ],
            },
            "id": "product-inference-default",
            "name": "file:///product/inference-default.js",
          },
        ],
      },
    ]
  `)
  expect(JSON.stringify(rows)).not.toContain('private-model-secret')
  expect(rows.some(row => row.id === 'llm-deepseek' || row.id === 'llm-pi-ai')).toBe(false)
})

it('keeps native API-key providers available when company models contain no DeepSeek route', () => {
  const rows = inferenceProfile({ modelApiKey: 'private', endpoints: { litellm: 'https://models.test/v1' },
    models: ['gpt-example'] }, 'file:///product/inference-default.js')
  expect(rows.filter(row => row.disabled).map(row => row.id)).toEqual(['llm-deepseek-account', 'ui-settings-account'])
})
