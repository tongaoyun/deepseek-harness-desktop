import type { ProductRuntimeMethod } from '@deepseek-harness/product/protocol'
import { describe, expect, it } from 'vitest'
import { invokeSmokeProduct } from '../scripts/smoke-runtime.ts'

describe('packaged runtime smoke product bridge', () => {
  it.each([
    'skills.list',
    'expertKits.list',
    'connectors.list',
    'expertKits.enablement.list',
  ] satisfies ProductRuntimeMethod[])('provides an empty %s catalog without employee credentials', async (method) => {
    await expect(invokeSmokeProduct(method)).resolves.toEqual([])
  })

  it('fails closed when Host startup adds an unmodeled product operation', async () => {
    await expect(invokeSmokeProduct('knowledge.bases.list')).rejects.toThrow(
      'desktop runtime: unexpected product operation knowledge.bases.list',
    )
  })
})
