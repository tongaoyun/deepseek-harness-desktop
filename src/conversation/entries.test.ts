import { expect, it } from 'vitest'
import { appendSteerToOpenTurn, reconcileTaskConversation, resetOpenTurn } from './entries'
import { assistantEntry, userEntry } from './testing'

it('keeps steering inside the open turn and settles it with the task', () => {
  const open = [userEntry('prompt', '查订单'), assistantEntry('turn:1', [{
    kind: 'tool', id: 'ask', toolName: 'ask_user_question', label: '等待回答', status: 'running', startedAt: '2026-09-18T09:33:00Z',
  }], {}, 'streaming')]
  const steered = appendSteerToOpenTurn(open, { id: 'steer', role: 'user', source: 'steer', text: '店铺 A' })
  expect(steered).toHaveLength(2)
  expect(steered[1]).toMatchObject({ role: 'assistant', segments: [{ kind: 'tool' }, { kind: 'user', text: '店铺 A' }] })
  const stopped = reconcileTaskConversation(steered, 'canceled', '2026-09-18T09:35:00Z')
  expect(stopped[1]).toMatchObject({ role: 'assistant', status: 'canceled', segments: [{ kind: 'tool', status: 'canceled' }, { kind: 'user' }] })
})

it('keeps the submitted clock when recovery retries a running turn', () => {
  const submitted = '2026-09-18T09:33:00Z'
  const recovered = resetOpenTurn([userEntry('prompt', '计算'), assistantEntry('turn:1', [], { startedAt: submitted }, 'streaming')], '2026-09-18T09:33:32Z')
  expect(recovered.at(-1)).toMatchObject({ id: 'pending', meta: { startedAt: submitted } })
})
