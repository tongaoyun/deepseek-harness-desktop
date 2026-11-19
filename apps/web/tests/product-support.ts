/** Synthetic employee access for product browser tests using real native Remote services. */
import type { Browser, Page } from 'playwright'
import { newEnglishPage } from './support.ts'

/** Open an English product test page with a credential-free employee session.
 * @param browser Browser owning the isolated page.
 * @param height Initial viewport height.
 * @returns Page authorized for product navigation; unexpected desktop operations fail.
 */
export async function newEmployeePage(browser: Browser, height = 1000): Promise<Page> {
  const page = await newEnglishPage(browser, height)
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (namespace: string, method: string) => {
        if (namespace !== 'product' || method !== 'auth.getSession')
          throw new Error(`Unexpected employee operation: ${namespace}/${method}`)
        return { ok: true, result: { authenticated: true, employeeId: 'product-reviewer', displayName: 'Product reviewer' } }
      },
      cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  return page
}
