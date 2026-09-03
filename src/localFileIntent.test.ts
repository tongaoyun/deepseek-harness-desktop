import { describe, expect, it } from 'vitest'
import { needsLocalDirectoryAuthorization, standardLocalDirectories } from './localFileIntent'

describe('needsLocalDirectoryAuthorization', () => {
  it.each([
    '看下我的下载目录有啥',
    '列出 Downloads 里的文件',
    '读取 /Users/me/project/README.md',
    '打开 C:\\Users\\me\\Desktop\\notes.txt',
    '帮我生成一个 Excel 文件',
  ])('recognizes a local file task: %s', (input) => {
    expect(needsLocalDirectoryAuthorization(input)).toBe(true)
  })

  it.each([
    '总结今天的工作',
    '在知识库中搜索退款流程',
    '介绍一下连接器',
    '帮我写一份周报',
    '你能改本地文件么，或者查看吗',
    '是否支持操作电脑里的文件',
  ])('does not interrupt a non-file task: %s', (input) => {
    expect(needsLocalDirectoryAuthorization(input)).toBe(false)
  })

  it('resolves named system directories without a folder picker', () => {
    expect(standardLocalDirectories('看下下载目录和桌面有哪些文件')).toEqual(['downloads', 'desktop'])
    expect(standardLocalDirectories('read Documents')).toEqual(['documents'])
    expect(standardLocalDirectories('看看本地文件')).toEqual([])
  })
})
