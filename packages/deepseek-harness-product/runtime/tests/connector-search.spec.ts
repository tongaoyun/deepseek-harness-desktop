import { expect, it } from 'vitest'
import { connectorSearchQuery, rankConnectorTools } from '../src/connector-search.ts'

const tool = (raw: string, description: string) => ({ raw, tool: { description } })
const names = (documents: ReturnType<typeof tool>[], queries: string[]) => rankConnectorTools(documents, queries).map(item => item.raw)

it('uses model-supplied translations and synonyms without inferring missing meanings', () => {
  const documents = [tool('list_orders', '订单查询'), tool('void_order', '取消订单'), tool('stock', '库存查询')]
  expect(names(documents, ['撤销交易'])).toEqual([])
  expect(names(documents, ['撤销交易', '取消订单', 'void order'])[0]).toBe('void_order')
  expect(names(documents, ['取消订单', 'utterly unrelated synonym'])[0]).toBe('void_order')
})

it('keeps original names ahead of mentions and splits camel case without English substring matches', () => {
  const documents = [tool('archive', 'Use getOrderStatus to check orders first.'),
    tool('getOrderStatus', '订单状态'), tool('grid', 'Grid view')]
  expect(names(documents, ['getOrderStatus'])[0]).toBe('getOrderStatus')
  expect(names(documents, ['order status'])[0]).toBe('getOrderStatus')
  expect(names([tool('getERPOrders', '业务查询')], ['orders'])).toEqual(['getERPOrders'])
  expect(names(documents, ['id'])).toEqual([])
})

it('normalizes full-width text, case and punctuation', () => {
  expect(names([tool('cancel_order', '取消订单')], ['ＣＡＮＣＥＬ＿ＯＲＤＥＲ'])).toEqual(['cancel_order'])
  expect(names([tool('cancel_order', '取消订单')], ['ERP，取消订单？'])).toEqual(['cancel_order'])
})

it('weights distinctive operation words above ubiquitous description boilerplate', () => {
  const documents = Array.from({ length: 100 }, (_, i) => tool(`common_${i}`, 'order finance'))
  documents.push(tool('rare', 'cancellation'))
  expect(names(documents, ['order finance cancellation'])[0]).toBe('rare')
})

it('does not reward repeated description words or depend on input order for ties', () => {
  const documents = [tool('b', '订单 '.repeat(50)), tool('a', '订单')]
  expect(names(documents, ['订单'])).toEqual(['a', 'b'])
  expect(names(documents.reverse(), ['订单'])).toEqual(['a', 'b'])
})

it('does not return any tools for an unrelated query or empty catalog', () => {
  expect(names([tool('orders', '订单查询')], ['ERP'])).toEqual([])
  expect(names([], ['订单'])).toEqual([])
})

it('bounds and validates each primary or alternative expression', () => {
  for (const value of ['', '   ', '？！', 'x'.repeat(201)]) expect(connectorSearchQuery.safeParse(value).success).toBe(false)
  expect(connectorSearchQuery.parse('  取消订单  ')).toBe('取消订单')
})
