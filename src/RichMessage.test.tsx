import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RichMessage } from './RichMessage'

describe('rich message', () => {
  it('does not guess artifacts from response text', () => {
    const html = renderToStaticMarkup(<RichMessage assistant text="已生成 C:\\Reports\\sales.xlsx 和 /tmp/summary.pdf" />)
    expect(html).toContain('sales.xlsx')
    expect(html).not.toContain('artifact-list')
    expect(html).not.toContain('在文件夹中显示')
  })

  it('keeps the compact answer actions limited to copy and regenerate', () => {
    const html = renderToStaticMarkup(<RichMessage assistant onRegenerate={() => undefined} text="完成" />)
    expect(html).toContain('复制回答')
    expect(html).toContain('重新回答')
    expect(html).not.toContain('赞同')
  })
})
