import { expect, it } from 'vitest'
import { captureInteractionSegments, restoreInteractionSegments } from './interactionSegments'
import { assistantEntry, userEntry } from './testing'
import type { ConversationEntry, QuestionSegment } from './types'

const question: QuestionSegment = { kind: 'question', id: 'question:q1', questionId: 'q1', label: '需要你的回答',
  questions: [{ id: 'number', question: '哪个数？', options: [{ label: '42' }] }], status: 'completed',
  answers: [{ id: 'number', selected: ['42'] }] }

it('replays only product-owned question and steering segments into the durable transcript', () => {
  const live: ConversationEntry[] = [userEntry('u1', '计算'), assistantEntry('turn:1', [
    { kind: 'tool', id: 'tool:ask', toolName: 'ask_user_question', status: 'completed', startedAt: '', label: '提问' },
    question, { kind: 'user', id: 'steer:1', text: '再检查' }, { kind: 'text', id: 'text:1', text: '49' },
  ], {}, 'completed')]
  const saved = captureInteractionSegments('session-1', live)
  expect(saved.map((item) => item.segment.kind)).toEqual(['question', 'user'])
  const transcript: ConversationEntry[] = [userEntry('u1', '计算'), assistantEntry('turn:1', [
    { kind: 'tool', id: 'tool:ask', toolName: 'ask_user_question', status: 'completed', startedAt: '', label: '提问' },
    { kind: 'text', id: 'text:1', text: '49' },
  ], {}, 'completed')]
  const replay = restoreInteractionSegments('session-1', transcript, saved)
  expect(replay[1]).toMatchObject({ segments: [{ kind: 'tool' }, question, { kind: 'user', text: '再检查' }, { kind: 'text', text: '49' }] })
  expect(restoreInteractionSegments('session-1', replay, saved)).toEqual(replay)
  expect(restoreInteractionSegments('session-2', transcript, saved)).toEqual(transcript)
})

it('replaces a provisional pending question with its final acknowledged answer', () => {
  const pending = captureInteractionSegments('session-1', [assistantEntry('pending', [{ ...question, status: 'running', answers: undefined }], {}, 'streaming')])
  const final = captureInteractionSegments('session-1', [assistantEntry('turn:1', [question], {}, 'completed')], pending)
  const replay = restoreInteractionSegments('session-1', [assistantEntry('turn:1', [], {}, 'completed')], final)
  expect(replay[0]).toMatchObject({ segments: [question] })
})
