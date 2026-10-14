import { describe, expect, it } from 'vitest'
import { markdownValidationSource } from './markdown.ts'

describe('Chinese documentation validation headings', () => {
  it('normalizes structural headings while preserving source lines and entry titles', () => {
    const source = '# 产品\n\n## 概述\n\n正文\n\n## 模型体验\n\n### 知识检索\n\n#### 模型看到的内容\n\n#### Token 影响\n\n#### KV Cache 影响\n\n## 迁移\n'
    const normalized = markdownValidationSource(source)
    expect(normalized).toBe('# 产品\n\n## Summary\n\n正文\n\n## Model Experience\n\n### 知识检索\n\n#### What the model sees\n\n#### Token effect\n\n#### KV Cache effect\n\n## Migration\n')
    expect(normalized.split('\n')).toHaveLength(source.split('\n').length)
  })

  it('does not rewrite prose, fenced code, comments or existing English headings', () => {
    const source = '概述\n\n```md\n## 概述\n```\n\n<!--\n## 模型体验\n-->\n\n## Summary\n\n## 未知章节\n'
    expect(markdownValidationSource(source)).toBe(source)
  })
})
