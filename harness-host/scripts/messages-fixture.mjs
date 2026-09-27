// Small rc.2 Messages/SSE fixture used by local acceptance scripts.
export function toolNames(body) {
  return (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.name ?? tool?.function?.name).filter(Boolean)
}

export function toolResultMessages(body) {
  return (Array.isArray(body.messages) ? body.messages : []).filter((message) =>
    Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_result'))
}

export function writeMessagesResponse(response, { text = '', toolCalls = [], model = 'fixture' } = {}) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'fixture-message', model, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`)
  let index = 0
  if (text) {
    response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`)
    response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}\n\n`)
    response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`)
    index += 1
  }
  for (const call of toolCalls) {
    response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })}\n\n`)
    response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input ?? {}) } })}\n\n`)
    response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`)
    index += 1
  }
  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn'
  response.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } })}\n\n`)
  response.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
}
