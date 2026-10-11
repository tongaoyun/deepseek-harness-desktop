import { expect, it } from 'vitest'
import { productDevelopmentEnvironment, resolveProductDevelopmentHome, resolveProductDevelopmentUserData } from '../scripts/environment.ts'

it('does not reuse the official DSH_HOME for product development', () => {
  const environment = { DSH_HOME: '/tmp/official-home', DSH_PRODUCT_HOME: undefined }
  expect(resolveProductDevelopmentHome('/workspace', environment)).toBe(
    '/workspace/apps/desktop/.desktop-build/product-development/home',
  )
  expect(productDevelopmentEnvironment('/workspace', environment)).toMatchObject({
    DSH_HOME: '/workspace/apps/desktop/.desktop-build/product-development/home',
    DSH_DESKTOP_USER_DATA_DIR: '/workspace/apps/desktop/.desktop-build/product-development/electron-user-data',
  })
})

it('accepts an explicit product home for isolated fixtures', () => {
  expect(resolveProductDevelopmentHome('/workspace', { DSH_PRODUCT_HOME: '/tmp/product-home' }))
    .toBe('/tmp/product-home')
})

it('keeps product Electron data separate from the official desktop data', () => {
  expect(resolveProductDevelopmentUserData('/workspace', { DSH_DESKTOP_USER_DATA_DIR: '/tmp/official-user-data' }))
    .toBe('/workspace/apps/desktop/.desktop-build/product-development/electron-user-data')
  expect(resolveProductDevelopmentUserData('/workspace', { DSH_PRODUCT_USER_DATA: '/tmp/product-user-data' }))
    .toBe('/tmp/product-user-data')
})
