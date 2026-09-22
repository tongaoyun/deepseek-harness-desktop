import { publicErrorMessage } from './public-error.js'

export type HarnessErrorCategory =
  | 'timeout'
  | 'authentication'
  | 'capacity'
  | 'permission'
  | 'connector'
  | 'local-agent'
  | 'model'
  | 'unknown'

export interface HarnessErrorData {
  code: string
  category: HarnessErrorCategory
  title: string
  detail: string
  infrastructure: boolean
  retryable: boolean
}

/** Errors crossing the Harness Host boundary carry their retry policy explicitly. */
export class HarnessError extends Error {
  readonly data: HarnessErrorData

  constructor(data: HarnessErrorData) {
    super(data.detail)
    this.name = 'HarnessError'
    this.data = data
  }
}

export function harnessError(data: HarnessErrorData): HarnessError {
  return new HarnessError(data)
}

export function errorData(error: unknown): HarnessErrorData {
  if (error instanceof HarnessError) return error.data
  if (errorMessage(error).includes('cannot create effect on inactive context')) {
    return data(
      'XY-AGENT-CONTEXT',
      'local-agent',
      '任务执行上下文已失效',
      '当前任务执行上下文已失效，请重新发送任务',
      true,
      true,
    )
  }
  return {
    code: 'XY-HOST-ERROR',
    category: 'unknown',
    title: '任务执行失败',
    detail: publicErrorMessage(error),
    infrastructure: false,
    retryable: false,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const value = record(error)
  if (typeof value?.message === 'string') return value.message
  if (typeof value?.detail === 'string') return value.detail
  return ''
}

export function errorDataForProvider(reason: Record<string, unknown>): HarnessErrorData {
  const error = record(reason.error) ?? record(reason.failure) ?? reason
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : typeof error.type === 'string' ? error.type.toUpperCase() : ''
  const statusValue = error.status ?? error.statusCode ?? error.status_code
  const status = typeof statusValue === 'number' ? statusValue : typeof statusValue === 'string' && /^\d{3}$/u.test(statusValue) ? Number(statusValue) : undefined
  if (status === 401 || code === 'AUTH' || code === 'UNAUTHORIZED' || code === 'AUTHENTICATION') {
    return data('XY-AUTH', 'authentication', '模型认证失败', '模型服务认证失败，请联系管理员检查配置', false, false)
  }
  if (status === 429 || code === 'RATE_LIMIT' || code === 'CAPACITY') {
    return data('XY-CAPACITY', 'capacity', '模型服务繁忙', '模型服务繁忙，请稍后重试', false, true)
  }
  if (code === 'CONTEXT_LENGTH' || code === 'MAX_CONTEXT' || code === 'INVALID_MODEL_CONTEXT') {
    return data('XY-CONTEXT-LIMIT', 'model', '会话内容过长', '当前会话内容过长，请新建任务或缩短上下文后重试', false, false)
  }
  if (code === 'EMPTY_RESPONSE') {
    return data('XY-MODEL-EMPTY', 'model', '模型未返回内容', '模型服务未返回有效内容，请稍后重试', true, true)
  }
  if (code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'NETWORK' || code === 'UNAVAILABLE' || code === 'SERVER' || status !== undefined && status >= 500) {
    return data('XY-MODEL-UNAVAILABLE', 'model', '模型服务不可用', '模型服务暂时不可用，请稍后重试', false, true)
  }
  return data('XY-MODEL-UNKNOWN', 'model', '模型未能完成任务', '模型服务未能完成本轮请求，请检查后继续', false, false)
}

export function isHarnessErrorData(value: unknown): value is HarnessErrorData {
  const item = record(value)
  return Boolean(item
    && typeof item.code === 'string' && /^XY-[A-Z0-9-]+$/u.test(item.code)
    && isCategory(item.category)
    && typeof item.title === 'string' && item.title.length > 0
    && typeof item.detail === 'string' && item.detail.length > 0
    && typeof item.infrastructure === 'boolean'
    && typeof item.retryable === 'boolean')
}

export function data(
  code: string,
  category: HarnessErrorCategory,
  title: string,
  detail: string,
  infrastructure: boolean,
  retryable: boolean,
): HarnessErrorData {
  return { code, category, title, detail, infrastructure, retryable }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isCategory(value: unknown): value is HarnessErrorCategory {
  return ['timeout', 'authentication', 'capacity', 'permission', 'connector', 'local-agent', 'model', 'unknown'].includes(String(value))
}
