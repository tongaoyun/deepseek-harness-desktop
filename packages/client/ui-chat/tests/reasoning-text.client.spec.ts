import { describe, expect, it } from 'vitest'
import { reasoningText } from '../src/client/reasoning-text.ts'

describe('reasoning display text', () => {
  it.each([
    '',
    'Ordinary reasoning',
    '普通思考正文',
    '\n  Original text  \n',
    '<note>Original text</note>',
    'Body <signature>literal</signature>',
    ' <signature>literal</signature>',
  ])('preserves ordinary reasoning %j', (text) => {
    expect(reasoningText(text)).toBe(text)
  })

  it.each(['<', '<sig', '<signature>', '<signature>opaque', '<signature>opaque</sig',
    '<signature>opaque</signature>', '<signature>opaque</signature>\r\n\n'])('hides metadata-only streaming text %j', (text) => {
    expect(reasoningText(text)).toBe('')
  })

  it.each([
    ['<signature>opaque</signature>Body', 'Body'],
    ['<signature>opaque</signature>\n\r\n\n  Body  \n', '  Body  \n'],
    ['<signature>opaque</signature>\rBody', '\rBody'],
    ['<signature>opaque</signature>\nBody <signature>literal</signature>', 'Body <signature>literal</signature>'],
  ])('removes only leading signature metadata from %j', (text, expected) => {
    expect(reasoningText(text)).toBe(expected)
  })
})
