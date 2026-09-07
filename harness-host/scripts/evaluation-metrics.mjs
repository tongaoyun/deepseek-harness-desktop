export function evaluationMetrics() {
  const started = performance.now()
  const samples = new Map()
  const tools = []
  let firstActivityMs = null
  return {
    collect(notification) {
      const event = notification.params?.event
      if (!event) return
      if (firstActivityMs === null && ['tool/call', 'assistant/chunk'].includes(event.type)) firstActivityMs = Math.round(performance.now() - started)
      if (event.type === 'tool/call') tools.push(event.data.name)
      const usage = event.type === 'assistant/message' ? event.data.usage
        : event.type === 'assistant/chunk' && event.data.chunk?.type === 'usage' ? event.data.chunk.usage : undefined
      if (usage && event.data.turn !== undefined && event.data.step !== undefined) {
        samples.set(JSON.stringify([notification.params.sessionId, event.data.turn, event.data.step]), usage)
      }
    },
    result() {
      const tokens = samples.size ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null
      for (const usage of samples.values()) {
        for (const name of ['input', 'output', 'cacheRead', 'cacheWrite']) tokens[name] += usage[`${name}Tokens`] ?? 0
      }
      const prices = ['INPUT', 'OUTPUT', 'CACHE_READ', 'CACHE_WRITE'].map((key) => process.env[`XIAOYIN_EVAL_${key}_PER_MILLION`])
      const pricingAvailable = prices.every((price) => price !== undefined && price.trim() !== '' && Number.isFinite(Number(price)) && Number(price) >= 0)
      const estimatedCost = tokens && pricingAvailable
        ? Object.values(tokens).reduce((cost, count, index) => cost + count * Number(prices[index]) / 1_000_000, 0) : null
      return { durationMs: Math.round(performance.now() - started), firstActivityMs, toolCalls: tools.length, tools, providerTokens: tokens, estimatedCost, costCurrency: estimatedCost === null ? null : process.env.XIAOYIN_EVAL_CURRENCY ?? 'CNY' }
    },
  }
}
