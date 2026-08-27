export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcOutput = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false
  return value.jsonrpc === '2.0'
    && Object.hasOwn(value, 'id')
    && typeof value.method === 'string'
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

export function notification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
