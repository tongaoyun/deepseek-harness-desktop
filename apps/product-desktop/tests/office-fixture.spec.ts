import { unzipSync, strFromU8 } from 'fflate'
import { expect, it, onTestFinished, vi } from 'vitest'
import { realOfficeBytes } from '../../web/tests/office-fixture.ts'

it.each([
  ['docx', 'word/document.xml'],
  ['xlsx', 'xl/worksheets/sheet1.xml'],
  ['pptx', 'ppt/slides/slide1.xml'],
] as const)('keeps %s original bytes identical across download and later verification', (extension, document) => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0))
  const downloaded = realOfficeBytes(extension)
  vi.setSystemTime(new Date(2026, 9, 18, 20, 30, 30))
  const expected = realOfficeBytes(extension)
  expect(Buffer.from(downloaded)).toEqual(Buffer.from(expected))
  const files = unzipSync(downloaded)
  expect(strFromU8(files[document])).toContain('Office preview 中文文档')
  expect(files['[Content_Types].xml']).toBeDefined()
})
