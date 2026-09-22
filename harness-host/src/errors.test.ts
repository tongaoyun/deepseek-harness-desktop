import { describe, expect, it } from 'vitest'
import { data, errorData, errorDataForProvider, isHarnessErrorData } from './errors.js'
import { failure } from './protocol.js'

describe('Harness error contract', () => {
  it('requires an explicit retry decision for every wire error', () => {
    const value = data('XY-CAPACITY', 'capacity', '模型服务繁忙', '稍后重试', false, true)
    expect(isHarnessErrorData(value)).toBe(true)
    expect(failure(1, -32001, value.detail, value).error.data).toEqual(value)
  })

  it('fails closed for provider errors without a structured code', () => {
    expect(errorDataForProvider({ error: { message: 'provider failed' } })).toMatchObject({
      code: 'XY-MODEL-UNKNOWN', category: 'model', retryable: false,
    })
  })

  it('keeps known transient provider failures retryable', () => {
    expect(errorDataForProvider({ error: { status: 429 } })).toMatchObject({
      code: 'XY-CAPACITY', category: 'capacity', retryable: true,
    })
  })

  it.each(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'])('maps the Harness transient code %s without reading its message', (code) => {
    expect(errorDataForProvider({ error: { code, message: 'opaque provider detail' } })).toMatchObject({
      code: code === 'EMPTY_RESPONSE' ? 'XY-MODEL-EMPTY' : 'XY-MODEL-UNAVAILABLE',
      retryable: true,
    })
  })

  it('accepts the provider status field in its serialized form', () => {
    expect(errorDataForProvider({ error: { statusCode: '503' } })).toMatchObject({ code: 'XY-MODEL-UNAVAILABLE', retryable: true })
  })

  it('turns an inactive Cordis context into a recoverable local-agent error', () => {
    expect(errorData(new Error('cannot create effect on inactive context'))).toMatchObject({
      code: 'XY-AGENT-CONTEXT',
      category: 'local-agent',
      retryable: true,
    })
    expect(errorData({ message: 'cannot create effect on inactive context' })).toMatchObject({
      code: 'XY-AGENT-CONTEXT',
      category: 'local-agent',
      retryable: true,
    })
    expect(errorData('cannot create effect on inactive context')).toMatchObject({
      code: 'XY-AGENT-CONTEXT',
      category: 'local-agent',
      retryable: true,
    })
  })
})
