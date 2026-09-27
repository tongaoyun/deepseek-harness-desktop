import { describe, expect, it } from 'vitest'
import { readServerData, readServerPage } from './serverResponse'

describe('COLA server response', () => {
  it('returns object and collection data', async () => {
    for (const data of [{ id: 'one' }, [], [{ id: 'one' }]]) {
      await expect(readServerData(new Response(JSON.stringify({ success: true, data })))).resolves.toEqual(data)
    }
  })

  it('rejects malformed bodies, missing payloads and business failures', async () => {
    for (const body of [[], { id: 'one' }, { success: true }, { success: false, errCode: 'MEMORY_CONFLICT', errMessage: '版本冲突' }]) {
      await expect(readServerData(new Response(JSON.stringify(body)))).rejects.toThrow()
    }
    await expect(readServerData(new Response(JSON.stringify({ success: false, errCode: 'MEMORY_CONFLICT', errMessage: '版本冲突' }), { status: 409 }))).rejects.toThrow('版本冲突')
  })

  it('rejects paginated responses without complete pagination metadata', async () => {
    await expect(readServerPage(new Response(JSON.stringify({ success: true, data: [] })))).rejects.toThrow('分页元数据')
    await expect(readServerPage(new Response(JSON.stringify({ success: true, data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 })))).resolves.toMatchObject({
      page: 0, size: 20, total: 0, totalPages: 0, items: [],
    })
  })
})
