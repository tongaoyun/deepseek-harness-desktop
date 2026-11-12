// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ConnectorTools } from '../src/client/ConnectorTools.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

afterEach(cleanup)
const t = (key: DeepSeekHarnessProductKey): string => zh[key]
const tools = Array.from({ length: 125 }, (_, index) => ({ name: `order.tool_${index}`,
  displayName: `订单能力 ${index}`, description: `完整说明 ${index}\n需要保留的注意事项`, access: index % 2 === 0 ? 'READ' as const : 'WRITE' as const }))

it('bounds a large catalog, expands full descriptions and searches tools beyond the visible batch', () => {
  render(<ConnectorTools tools={tools} t={t} />)
  fireEvent.click(screen.getByText(zh.viewConnectorTools.replace('{count}', '125')))
  expect(screen.getAllByRole('listitem')).toHaveLength(20)
  expect(screen.queryByText('订单能力 124')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.showMoreConnectorTools.replace('{shown}', '20').replace('{total}', '125') }))
  expect(screen.getAllByRole('listitem')).toHaveLength(40)
  fireEvent.change(screen.getByRole('searchbox', { name: zh.searchConnectorTools }), { target: { value: 'order.tool_124' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  const row = screen.getByRole('listitem')
  expect(within(row).queryByText('order.tool_124')?.closest('details')?.open).toBe(false)
  fireEvent.click(screen.getByText('订单能力 124'))
  expect(within(row).getByText('order.tool_124').closest('details')?.open).toBe(true)
  expect(within(row).getByText(/完整说明 124/).textContent).toBe('完整说明 124\n需要保留的注意事项')
  expect(row.textContent).toMatchSnapshot()
})

it('combines description search and access filtering, then restores the initial batch', () => {
  render(<ConnectorTools tools={tools} t={t} />)
  fireEvent.click(screen.getByText(zh.viewConnectorTools.replace('{count}', '125')))
  fireEvent.change(screen.getByRole('searchbox', { name: zh.searchConnectorTools }), { target: { value: '完整说明 124' } })
  fireEvent.change(screen.getByRole('combobox', { name: zh.connectorToolAccess }), { target: { value: 'WRITE' } })
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(screen.getByText(zh.noSearchResults)).toBeTruthy()
  const clear = screen.getByRole('button', { name: zh.clearConnectorFilters })
  clear.focus()
  fireEvent.click(clear)
  expect(screen.getAllByRole('listitem')).toHaveLength(20)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('all')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'WRITE' } })
  expect(screen.queryByText('订单能力 0')).toBeNull()
  expect(screen.getByText('订单能力 1')).toBeTruthy()
})

it.each([21, 45])('keeps the keyboard at the newly revealed tools when all %s capabilities are shown', (total) => {
  const view = render(<ConnectorTools tools={tools.slice(0, total)} t={t} />)
  fireEvent.click(screen.getByText(zh.viewConnectorTools.replace('{count}', String(total))))
  const first = screen.getByText('订单能力 0').closest('summary')!
  fireEvent.click(first)
  const more = screen.getByRole('button', { name: zh.showMoreConnectorTools.replace('{shown}', '20').replace('{total}', String(total)) })
  more.focus()
  fireEvent.click(more)
  if (total > 40) {
    expect(document.activeElement).toBe(more)
    fireEvent.click(more)
  }
  const firstNew = screen.getByText(`订单能力 ${total > 40 ? 40 : 20}`).closest('summary')!
  expect(document.activeElement).toBe(firstNew)
  expect(more.isConnected).toBe(false)
  expect(screen.getByText('订单能力 0').closest('summary')).toBe(first)
  expect(first.parentElement).toHaveProperty('open', true)
  expect(screen.getAllByRole('listitem')).toHaveLength(total)
  expect({ focused: document.activeElement?.textContent, count: screen.getAllByRole('listitem').length }).toMatchSnapshot('Expanded tools focus')
  view.unmount()
})
