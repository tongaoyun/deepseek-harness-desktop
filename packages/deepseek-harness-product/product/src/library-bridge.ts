/** Validated metadata operations; original bytes stay in the main-owned file transport. */
import { z } from 'zod'
import { ProductError } from './errors.ts'
import type { DeepSeekHarnessApiClient } from './http-client.ts'
import {
  LibrarySchema,
  LibraryEntrySchema,
  LibraryPageSchema,
  LibraryEntryPageSchema,
  LibraryIdentitySchema,
  LibraryFilePageSchema,
  LibraryFileQuerySchema,
} from './library.ts'
const id = z.uuid()
const name = z.string().trim().min(1).max(180)
const version = z.number().int().positive()
function reply(valid: boolean): void {
  if (!valid) throw new ProductError('INVALID_SERVER_RESPONSE', 'Library response does not match the request', false)
}
function pageReply(
  value: {
    pageIndex: number
    pageSize: number
    totalCount: number
    totalPages: number
    data: readonly { id: string }[]
  },
  page: number,
  size: number,
): void {
  reply(
    value.pageIndex === page &&
      value.pageSize === size &&
      value.totalPages === Math.ceil(value.totalCount / size) &&
      value.data.length <= size &&
      new Set(value.data.map(row => row.id)).size === value.data.length,
  )
}
const libraryIdentity = z.object({ libraryId: id }).strict()
const paging = {
  page: z.number().int().min(1).max(1_000_000).default(1),
  size: z.number().int().min(1).max(100).default(20),
}
const write = {
  name,
  description: z.string().max(1000),
  scope: z.enum(['PERSONAL', 'DEPARTMENT', 'COMPANY']),
  ownerId: z.string().min(1).optional(),
  managerEmployeeId: z.string().min(1).optional(),
}
const key = z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/u)
/** Dispatch one allowlisted library metadata request.
 * @param api Employee-authenticated server client.
 * @param method Product metadata method.
 * @param input Untrusted IPC payload.
 * @param signal Employee and request lifecycle.
 * @returns Validated metadata or a completed mutation receipt.
 */
export async function invokeLibrary(
  api: DeepSeekHarnessApiClient,
  method: string,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<unknown> {
  const json = (body: unknown, verb: string, requestKey?: string): RequestInit => ({
    method: verb,
    signal,
    headers: {
      'content-type': 'application/json',
      ...(requestKey === undefined ? {} : { 'Idempotency-Key': requestKey }),
    },
    body: JSON.stringify(body),
  })
  if (method === 'library.files.list') {
    const { page, size, ...filters } = LibraryFileQuerySchema.extend(paging).strict().parse(input)
    const result = LibraryFilePageSchema.parse(await api.list(
      `/api/v1/library-files?${new URLSearchParams(filters)}`, page, size, signal,
    ))
    pageReply({ ...result, data: result.data.map(row => row.entry) }, page, size)
    reply(result.data.every(row => filters.view !== 'favorites' || row.entry.favorite))
    return result
  }
  if (method === 'library.entries.access') {
    const value = LibraryIdentitySchema.parse(input)
    const result = await api.request(`/api/v1/libraries/${value.libraryId}/entries/${value.entryId}/access`, {
      method: 'PUT', signal,
    })
    reply(result === true)
    return result
  }
  if (method === 'library.list') {
    const query = z
      .object({ ...paging, query: z.string().max(180).default('') })
      .strict()
      .parse(input)
    const result = LibraryPageSchema.parse(
      await api.list(
        `/api/v1/libraries?${new URLSearchParams({ query: query.query })}`,
        query.page,
        query.size,
        signal,
      ),
    )
    pageReply(result, query.page, query.size)
    return result
  }
  if (method === 'library.create') {
    const { key: requestKey, ...body } = z
      .object({ ...write, key })
      .strict()
      .parse(input)
    const result = LibrarySchema.parse(await api.request('/api/v1/libraries', json(body, 'POST', requestKey)))
    reply(result.name === body.name && result.description === body.description && result.scope === body.scope)
    return result
  }
  if (method === 'library.files.policy')
    return z
      .number()
      .int()
      .positive()
      .parse(await api.request('/api/v1/libraries/file-policy', { signal }))
  if (method === 'library.get') {
    const value = libraryIdentity.parse(input)
    const result = LibrarySchema.parse(await api.request(`/api/v1/libraries/${value.libraryId}`, { signal }))
    reply(result.id === value.libraryId)
    return result
  }
  if (method === 'library.update') {
    const { libraryId, ...body } = z
      .object({ libraryId: id, ...write, version })
      .strict()
      .parse(input)
    const result = LibrarySchema.parse(await api.request(`/api/v1/libraries/${libraryId}`, json(body, 'PUT')))
    reply(
      result.id === libraryId &&
        result.version === body.version + 1 &&
        result.name === body.name &&
        result.description === body.description &&
        result.scope === body.scope,
    )
    return result
  }
  if (method === 'library.delete') {
    const value = z.object({ libraryId: id, version }).strict().parse(input)
    const result = await api.request(`/api/v1/libraries/${value.libraryId}?version=${value.version}`, {
      method: 'DELETE',
      signal,
    })
    reply(result === true)
    return result
  }
  if (method === 'library.entries.list') {
    const { libraryId, ...query } = z
      .object({
        libraryId: id,
        parentId: id.nullable().optional(),
        query: z.string().max(180).default(''),
        view: z.enum(['folder', 'folders', 'recent', 'favorites']).default('folder'),
        ...paging,
      })
      .strict()
      .parse(input)
    const params = new URLSearchParams()
    if (query.parentId != null) params.set('parentId', query.parentId)
    params.set('query', query.query)
    params.set('view', query.view)
    const result = LibraryEntryPageSchema.parse(
      await api.list(`/api/v1/libraries/${libraryId}/entries?${params}`, query.page, query.size, signal),
    )
    pageReply(result, query.page, query.size)
    reply(
      result.data.every(
        row =>
          row.libraryId === libraryId &&
          (!['folder', 'folders'].includes(query.view) || query.query.trim() !== '' || row.parentId === (query.parentId ?? null))
          && (query.view !== 'folders' || row.kind === 'FOLDER'),
      ),
    )
    return result
  }
  if (method === 'library.entries.get') {
    const value = LibraryIdentitySchema.parse(input)
    const entry = LibraryEntrySchema.parse(
      await api.request(`/api/v1/libraries/${value.libraryId}/entries/${value.entryId}`, { signal }),
    )
    reply(entry.id === value.entryId && entry.libraryId === value.libraryId)
    return entry
  }
  if (method === 'library.folders.create') {
    const {
      libraryId,
      key: requestKey,
      ...body
    } = z.object({ libraryId: id, parentId: id.nullable(), name, key }).strict().parse(input)
    const result = LibraryEntrySchema.parse(
      await api.request(`/api/v1/libraries/${libraryId}/folders`, json(body, 'POST', requestKey)),
    )
    reply(
      result.libraryId === libraryId &&
        result.kind === 'FOLDER' &&
        result.name === body.name &&
        result.parentId === body.parentId,
    )
    return result
  }
  if (method === 'library.entries.update') {
    const { libraryId, entryId, ...body } = z
      .object({ ...LibraryIdentitySchema.shape, name, parentId: id.nullable(), version })
      .strict()
      .parse(input)
    const result = LibraryEntrySchema.parse(
      await api.request(`/api/v1/libraries/${libraryId}/entries/${entryId}`, json(body, 'PUT')),
    )
    reply(
      result.libraryId === libraryId &&
        result.id === entryId &&
        result.version === body.version + 1 &&
        result.name === body.name &&
        result.parentId === body.parentId,
    )
    return result
  }
  if (method === 'library.entries.delete') {
    const value = z
      .object({ ...LibraryIdentitySchema.shape, version })
      .strict()
      .parse(input)
    const result = await api.request(
      `/api/v1/libraries/${value.libraryId}/entries/${value.entryId}?version=${value.version}`,
      { method: 'DELETE', signal },
    )
    reply(result === true)
    return result
  }
  if (method === 'library.entries.favorite') {
    const value = z
      .object({ ...LibraryIdentitySchema.shape, value: z.boolean() })
      .strict()
      .parse(input)
    const result = await api.request(
      `/api/v1/libraries/${value.libraryId}/entries/${value.entryId}/favorite?value=${value.value}`,
      { method: 'PUT', signal },
    )
    reply(result === value.value)
    return result
  }
  throw new Error('Unsupported library metadata operation')
}
