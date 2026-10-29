import { expect, it, vi } from 'vitest'
import { ProductCatalogManager } from './catalog-manager.ts'

function manager(api: { listAll: ReturnType<typeof vi.fn> }) {
  return new ProductCatalogManager({
    api: api as never,
    getSession: () => ({ authenticated: true, employeeId: 'employee-a' }),
    ensureFreshSession: () => Promise.resolve(undefined),
    getIdentitySignal: () => new AbortController().signal,
    emit: vi.fn(),
  })
}

it.each(['constructor', 'toString', '__proto__'])(
  'rejects inherited catalog method %s before touching the API', async (method) => {
    const api = { listAll: vi.fn() }
    const catalogs = manager(api)
    await expect(catalogs.read(method as never)).rejects.toThrow(`method ${method} is not available`)
    expect(api.listAll).not.toHaveBeenCalled()
    await catalogs.dispose()
  },
)
