import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluationMetrics } from '../harness-host/scripts/evaluation-metrics.mjs'

test('counts provider usage once per session, turn and step', () => {
  const metrics = evaluationMetrics()
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 }
  const event = (type, data, sessionId = 'one') => ({ params: { sessionId, event: { type, data: { turn: 1, step: 1, ...data } } } })
  metrics.collect(event('assistant/chunk', { chunk: { type: 'usage', usage } }))
  metrics.collect(event('assistant/message', { usage }))
  metrics.collect(event('assistant/message', { usage }, 'two'))
  metrics.collect(event('tool/call', { name: 'local_files_read_text' }))
  assert.deepEqual(metrics.result().providerTokens, { input: 20, output: 10, cacheRead: 40, cacheWrite: 0 })
  assert.equal(metrics.result().toolCalls, 1)
})

test('keeps unavailable provider usage and cost unknown', () => {
  const metrics = evaluationMetrics()
  metrics.collect({ params: { event: { type: 'assistant/chunk', data: { chunk: { type: 'text', text: 'hello' } } } } })
  assert.equal(metrics.result().providerTokens, null)
  assert.equal(metrics.result().estimatedCost, null)
})
