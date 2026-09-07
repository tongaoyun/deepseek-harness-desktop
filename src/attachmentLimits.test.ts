import { expect, it } from 'vitest'
import { attachmentSelectionError } from './attachmentLimits'
import type { LocalTaskAttachment } from './types'

const attachment = (index: number, kind: LocalTaskAttachment['kind'] = 'image'): LocalTaskAttachment => ({ id: String(index), rootId: 'root', rootName: '目录', path: String(index), name: String(index), kind })
it('checks image limits separately from the total attachment count and ignores duplicates', () => {
  const images = Array.from({ length: 4 }, (_, index) => attachment(index))
  expect(attachmentSelectionError([...images, images[0]])).toBeUndefined()
  expect(attachmentSelectionError([...images, attachment(4)])).toContain('4 张图片')
  expect(attachmentSelectionError([...images, ...Array.from({ length: 12 }, (_, index) => attachment(index + 4, 'file'))])).toBeUndefined()
  expect(attachmentSelectionError(Array.from({ length: 17 }, (_, index) => attachment(index, 'file')))).toContain('16 个附件')
})
