import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { expertKitGenerationPath, skillGenerationPath } from '../src/content.ts'

it('separates installed generations by normalized digest without creating Preset identities', () => {
  const first = { id: 'order-expert', sha256: 'A'.repeat(64) }
  const second = { ...first, sha256: 'b'.repeat(64) }
  expect(expertKitGenerationPath('/content', first)).toBe(resolve('/content', first.id, 'a'.repeat(64)))
  expect(expertKitGenerationPath('/content', second)).not.toBe(expertKitGenerationPath('/content', first))
  expect(skillGenerationPath('/content', first)).toBe(resolve('/content', 'a'.repeat(64), first.id))
})

it.each(['../outside', 'nested/path', 'invalid digest'])('rejects content identities that cannot address a generation: %s', (value) => {
  const content = value === 'invalid digest' ? { id: 'order-query', sha256: value } : { id: value, sha256: 'a'.repeat(64) }
  expect(() => expertKitGenerationPath('/content', content)).toThrow('Invalid product content identity')
  expect(() => skillGenerationPath('/content', content)).toThrow('Invalid product content identity')
})
