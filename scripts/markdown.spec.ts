/** Regression coverage for reusing one parse across the Markdown gate helpers. */

import { describe, expect, it } from 'vitest'
import { markdownHeadingLines, markdownProseLines, markdownValidationSource, parseMarkdown } from './markdown.ts'

const SOURCE = [
  '# Title',
  '',
  'Prose <!-- hidden --> kept.',
  '<!-- comment only -->',
  '',
  '```ts',
  '# not a heading',
  '```',
  '',
  'Setext heading',
  '--------------',
  '',
].join('\n')

describe('Markdown parse reuse', () => {
  it('derives prose lines and headings from a supplied parse exactly as from its own parse', () => {
    const tree = parseMarkdown(SOURCE)
    const unchanged = structuredClone(tree)

    const prose = markdownProseLines(SOURCE, tree)
    const headings = markdownHeadingLines(SOURCE, tree)

    expect(prose).toEqual(markdownProseLines(SOURCE))
    expect(headings).toEqual(markdownHeadingLines(SOURCE))
    expect(prose.map(line => line.index)).toEqual([1, 2, 3, 5, 9, 10, 11, 12])
    expect(headings).toEqual([
      { depth: 1, index: 1, raw: '# Title', text: 'Title' },
      { depth: 2, index: 10, raw: 'Setext heading', text: 'Setext heading' },
    ])
    expect(tree).toEqual(unchanged)
  })
})

describe('Chinese documentation validation', () => {
  it('normalizes structural headings while preserving prose, code, anchors, and line numbers', () => {
    const source = ['## 概述', '', '正文包含 ## 模型体验。', '<a id="model-experience"></a>', '## 模型体验',
      '### 专家委派', '#### 模型看到的内容', '#### Token 影响', '#### KV Cache 影响',
      '## 已知限制与延期工作', '- 需要员工登录。', '### 开发备注', '```md', '## 概述', '```'].join('\n')
    const expected = ['## Summary', '', '正文包含 ## 模型体验。', '<a id="model-experience"></a>', '## Model Experience',
      '### 专家委派', '#### What the model sees', '#### Token effect', '#### KV Cache effect',
      '## Known Limitations and Deferred Work', '- 需要员工登录。', '### Dev Note', '```md', '## 概述', '```'].join('\n')
    expect(markdownValidationSource(source)).toBe(expected)
    expect(markdownValidationSource(expected)).toBe(expected)
  })
})
