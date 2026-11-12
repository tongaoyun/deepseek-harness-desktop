import { expect, it } from 'vitest'
import { resolveContentCategory } from '../src/content-categories.ts'

it.each(['engineering', '研发与集成', 'Engineering & Integration', '  ENGINEERING & INTEGRATION  '])('解析分类标识和中英文名称：%s', (value) => {
  expect(resolveContentCategory(value)).toEqual({ id: 'engineering', zh: '研发与集成', en: 'Engineering & Integration' })
})

it.each([undefined, null, '', '  ', 'shared', '文档办公'])('空值和未收录分类归入其他：%s', (value) => {
  expect(resolveContentCategory(value)).toEqual({ id: 'specialized', zh: '其他', en: 'Other' })
})
