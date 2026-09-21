export type JsonRpcId = string | number | null

import { data, isHarnessErrorData, type HarnessErrorData } from './errors.js'

export type { HarnessErrorCategory, HarnessErrorData } from './errors.js'
export { errorData } from './errors.js'
export { isHarnessErrorData } from './errors.js'

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
    data: HarnessErrorData
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
  errorData?: Partial<HarnessErrorData>,
): JsonRpcFailure {
  const normalized: HarnessErrorData = {
    ...data('XY-HOST-ERROR', 'unknown', '请求失败', message, false, false),
    ...errorData,
    detail: errorData?.detail ?? message,
  }
  if (!isHarnessErrorData(normalized)) throw new Error('Invalid Harness error envelope')
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data: normalized,
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
