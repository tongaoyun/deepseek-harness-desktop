import { describe, expect, it } from 'vitest'
import { standardLocalDirectories } from './localFileIntent'

describe('standardLocalDirectories', () => {
  it.each(['生成 Word 文档', '从网站下载资料', '介绍桌面应用', '看看本地文件', '在默认工作目录生成 HTML'])('does not authorize a system directory for %s', (input) => {
    expect(standardLocalDirectories(input)).toEqual([])
  })

  it('resolves named system directories without a folder picker', () => {
    expect(standardLocalDirectories('看下下载目录和桌面有哪些文件')).toEqual(['downloads', 'desktop'])
    expect(standardLocalDirectories('read Documents')).toEqual(['documents'])
    expect(standardLocalDirectories('保存到文档文件夹')).toEqual(['documents'])
    expect(standardLocalDirectories('检查 ~/Downloads')).toEqual(['downloads'])
    expect(standardLocalDirectories('看看本地文件')).toEqual([])
  })
})
