// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductPanel } from '../src/client/ProductPanel.tsx'
import { zh, type XiaoyinProductKey } from '../src/locales.ts'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, 'xiaoyin')
})

const t = (key: XiaoyinProductKey): string => zh[key]

describe('Xiaoyin product panel', () => {
  it('shows a localized DingTalk sign-in action before loading protected catalogs', async () => {
    let authenticated = false
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'auth.ensureDingTalk') {
        authenticated = true
        return { authenticated: true }
      }
      return []
    })
    Object.defineProperty(globalThis, 'xiaoyin', { configurable: true, value: {
      product: { invoke, getSession: vi.fn(async () => ({ authenticated })) },
    } })

    render(<ProductPanel t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title }))

    expect(await screen.findByText(zh.authRequired)).not.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.signIn }))

    await waitFor(() => { expect(screen.getByRole('button', { name: /专家套件/ })).not.toBeNull() })
    expect(invoke).toHaveBeenNthCalledWith(1, 'auth.ensureDingTalk')
    expect(invoke).toHaveBeenCalledTimes(7)
  })

  it('replaces server exception details with product-facing copy', async () => {
    Object.defineProperty(globalThis, 'xiaoyin', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })),
      invoke: vi.fn(async () => { throw new Error('XiaoyinApiError: internal detail') }),
    } } })

    render(<ProductPanel t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title }))

    expect(await screen.findByText(zh.loadFailed)).not.toBeNull()
    expect(screen.queryByText(/XiaoyinApiError/)).toBeNull()
  })
})
