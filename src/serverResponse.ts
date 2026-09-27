interface ServerEnvelope<T> {
  success: boolean
  errCode?: string
  errMessage?: string
  data: T
}

export interface ServerPage<T> {
  items: T[]
  page: number
  size: number
  total: number
  totalPages: number
}

export async function readServerData<T>(response: Response): Promise<T> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || !('success' in value) || typeof value.success !== 'boolean') {
    throw new Error('服务端响应格式无效')
  }
  const envelope = value as ServerEnvelope<T>
  if (!response.ok || !envelope.success) {
    throw new Error(envelope.errMessage || `请求失败（${envelope.errCode || response.status}）`)
  }
  if (!('data' in envelope)) throw new Error('服务端响应缺少数据')
  return envelope.data
}

export async function readServerPage<T>(response: Response): Promise<ServerPage<T>> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || !('success' in value) || typeof value.success !== 'boolean') {
    throw new Error('服务端响应格式无效')
  }
  const envelope = value as ServerEnvelope<T[]> & { pageIndex?: number; pageSize?: number; totalCount?: number; totalPages?: number }
  if (!response.ok || !envelope.success) throw new Error(envelope.errMessage || `请求失败（${envelope.errCode || response.status}）`)
  if (!Array.isArray(envelope.data)) throw new Error('服务端分页响应缺少数据')
  if (!Number.isInteger(envelope.pageIndex) || !Number.isInteger(envelope.pageSize)
    || !Number.isInteger(envelope.totalCount) || !Number.isInteger(envelope.totalPages)) {
    throw new Error('服务端分页响应缺少分页元数据')
  }
  const pageIndex = envelope.pageIndex as number
  const pageSize = envelope.pageSize as number
  const totalCount = envelope.totalCount as number
  const totalPages = envelope.totalPages as number
  return {
    items: envelope.data,
    page: Math.max(0, pageIndex - 1),
    size: pageSize,
    total: totalCount,
    totalPages,
  }
}
