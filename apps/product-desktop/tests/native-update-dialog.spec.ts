import { expect, it, vi } from 'vitest'
import { dialogWithButton } from './native-product-update.mjs'

function windowAt(url: string, visible = true) {
  const isVisible = vi.fn(async () => visible)
  return { isClosed: () => false, url: () => url, getByRole: vi.fn(() => ({ isVisible })) }
}

it('selects the update confirmation when the product window has the same visible action', async () => {
  const product = windowAt('dsh-app://app/')
  const dialog = windowAt('dsh-app://shell/update-dialog.html')
  const selected = await dialogWithButton({ windows: () => [product, dialog] }, /^(Install and Restart|安装并重启)$/)
  expect(selected).toBe(dialog)
  expect(product.getByRole).not.toHaveBeenCalled()
  expect(dialog.getByRole).toHaveBeenCalledWith('button', { name: /^(Install and Restart|安装并重启)$/, exact: true })
})

it('waits for the exact dialog document rather than selecting a loading window or another shell page', async () => {
  const other = windowAt('dsh-app://shell/mandatory-update.html')
  const loading = windowAt('about:blank')
  const dialog = windowAt('dsh-app://shell/update-dialog.html')
  let observations = 0
  const selected = await dialogWithButton({ windows: () => ++observations === 1 ? [other, loading] : [other, dialog] }, 'Download update')
  expect(selected).toBe(dialog)
  expect(observations).toBeGreaterThan(1)
  expect(other.getByRole).not.toHaveBeenCalled()
  expect(loading.getByRole).not.toHaveBeenCalled()
})
