// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StructuredFilePreview, columnName } from './StructuredFilePreview'
import type { StructuredPreview } from './localArtifactPreview'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
async function fixture(value: StructuredPreview, run: (container: HTMLElement) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try { await act(async () => root.render(<StructuredFilePreview value={value} />)); await run(container) }
  finally { await act(async () => root.unmount()); container.remove() }
}

it('switches worksheets, preserves addresses, pages rows, and identifies missing formula results', async () => {
  await fixture({ type: 'spreadsheet', sheets: [
    { name: '销售', rowOffset: 2, columnOffset: 2, truncated: false, rows: Array.from({ length: 105 }, (_, index) => [{ value: `第${index + 3}行`, kind: 'text' }, { value: '', kind: 'number', formula: 'C3*2' }]) },
    { name: '备注', rowOffset: 0, columnOffset: 0, truncated: false, rows: [[{ value: '无需重算', kind: 'text' }]] },
  ] }, async container => {
    expect(container.querySelector('thead')?.textContent).toBe('CD')
    expect(container.querySelector('tbody th')?.textContent).toBe('3')
    expect(container.querySelector('tbody')?.textContent).toContain('待重算')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(100)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click())
    expect(container.querySelector('tbody th')?.textContent).toBe('103')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5)
    await act(async () => (container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click())
    expect(container.querySelector('tbody')?.textContent).toBe('1无需重算')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="上一页"]')?.disabled).toBe(true)
  })
})

it('renders document semantics and lets readers select presentation pages', async () => {
  await fixture({ type: 'document', blocks: [{ type: 'paragraph', text: '业务目标', level: 1 }, { type: 'table', rows: [['负责人', '事项'], ['产品组', '需求评审']] }] }, async container => {
    expect(container.querySelector('h1')?.textContent).toBe('业务目标')
    expect(container.querySelector('table')?.textContent).toContain('需求评审')
  })
  await fixture({ type: 'presentation', slides: [[{ type: 'paragraph', text: '目标', level: 0 }], [{ type: 'paragraph', text: '计划', level: 0 }]] }, async container => {
    await act(async () => (container.querySelectorAll('nav button')[1] as HTMLButtonElement).click())
    expect(container.querySelector('article')?.textContent).toBe('计划')
    expect(container.querySelector('header')?.textContent).toContain('第 2 / 2 页')
  })
})

it('uses spreadsheet column labels beyond Z', () => {
  expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
})
