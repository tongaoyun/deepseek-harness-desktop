import { describe, expect, it } from 'vitest'
import { previewStatusLabel } from './ExtensionPreviewPanel'

describe('extension preview status', () => {
  it('uses explicit user-facing labels for every terminal state', () => {
    expect(previewStatusLabel('idle')).toBe('等待测试')
    expect(previewStatusLabel('running')).toBe('运行中')
    expect(previewStatusLabel('completed')).toBe('本轮已结束')
    expect(previewStatusLabel('failed')).toBe('失败')
    expect(previewStatusLabel('canceled')).toBe('已取消')
  })
})
