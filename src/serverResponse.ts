interface ServerEnvelope<T> {
  success: boolean
  errCode?: string
  errMessage?: string
  data: T
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
