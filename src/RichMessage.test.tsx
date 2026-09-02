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
})
