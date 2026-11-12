// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { TeamEditor } from '../../src/client/team-editor.tsx'
import { TeamLocaleContext } from '../../src/client/team-locale.ts'
import { teamText } from '../../src/team-i18n.ts'
import type { ExpertSummary } from '../../src/expert-contract.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

beforeEach(() => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  onTestFinished(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTo', original)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360)
})

it.each((['zh', 'en'] as const).flatMap(language => [-1, 1].flatMap(direction => [false, true].map(elsewhere => ({
  language, direction, elsewhere,
})))))('keeps the moved member and its editing state through sorting in $language ($direction, elsewhere=$elsewhere)',
  ({ language, direction, elsewhere }) => {
    const text = (key: string) => teamText(language, key)
    const experts: ExpertSummary[] = Array.from({ length: 4 }, (_, index) => ({
      slug: `candidate-${index}`, name: `候选专家 ${index}`, nameEn: `Candidate ${index}`,
      description: '分析资料', descriptionEn: 'Analyze sources', emoji: '🔎', division: 'research', custom: true,
    }))
    const props = { initial: { ...TEST_TEAMS[0], members: experts.map(expert => ({
      expertSlug: expert.slug, duty: expert.slug, instructions: `分工 ${expert.slug}`,
    })) }, enabled: false, enabledExperts: experts.map(expert => expert.slug), save: vi.fn(), refresh: vi.fn(), close: vi.fn() }
    render(<TeamLocaleContext.Provider value={language}><TeamEditor {...props} experts={experts} /></TeamLocaleContext.Provider>)
    const start = direction === -1 ? experts.length - 1 : 0
    const duty = screen.getAllByRole<HTMLInputElement>('textbox', { name: text('职责摘要') })[start]
    const row = duty.closest('.agt-edit-member')!
    fireEvent.change(duty, { target: { value: '保留的职责草稿' } })
    fireEvent.click(within(row).getByText(text('展开详细分工')))
    const instructions = within(row).getByRole<HTMLTextAreaElement>('textbox', { name: text('详细分工') })
    fireEvent.change(instructions, { target: { value: '保留的详细分工草稿' } })
    const move = within(row).getByRole<HTMLButtonElement>('button', { name: text(direction === -1 ? '上移' : '下移') })
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: text('团队名称') })
    if (elsewhere) { name.focus(); name.setSelectionRange(1, 3) } else move.focus()
    for (let step = 1; step < experts.length; step++) {
      fireEvent.click(move)
      expect(document.activeElement === (elsewhere ? name : move)).toBe(true)
      expect(screen.getAllByRole('textbox', { name: text('职责摘要') })[start + direction * step]).toBe(duty)
      expect(duty.value).toBe('保留的职责草稿')
      expect(instructions.value).toBe('保留的详细分工草稿')
      expect(row.querySelector('details')?.open).toBe(true)
      if (elsewhere) expect([name.selectionStart, name.selectionEnd]).toEqual([1, 3])
    }
    expect(move.disabled).toBe(false)
    expect(move.getAttribute('aria-disabled')).toBe('true')
    const order = () => screen.getAllByRole<HTMLInputElement>('textbox', { name: text('职责摘要') }).map(field => field.value)
    const boundary = order()
    fireEvent.click(move); fireEvent.click(move)
    expect(order()).toEqual(boundary)
    expect(props.save).not.toHaveBeenCalled()
    expect(props.refresh).not.toHaveBeenCalled()
    expect({ order: order(), focused: document.activeElement === move ? move.textContent : name.name,
      expanded: row.querySelector('details')?.open, instructions: instructions.value }).toMatchSnapshot('Sorted member editing state')
  })

it.each(['add', 'eighth', 'replace'] as const)('continues editing the selected member after %s without saving', (action) => {
  const experts: ExpertSummary[] = Array.from({ length: 9 }, (_, index) => ({
    slug: `candidate-${index}`, name: `候选专家 ${index}`, nameEn: `Candidate ${index}`,
    description: `分析资料 ${index}`, descriptionEn: `Analyze sources ${index}`, emoji: '🔎', division: 'research', custom: true,
  }))
  const count = action === 'eighth' ? 7 : 2
  const props = { initial: { ...TEST_TEAMS[0], members: experts.slice(0, count).map(expert => ({
    expertSlug: expert.slug, duty: `原职责 ${expert.slug}`, instructions: '保留详细分工',
  })) }, enabled: false, enabledExperts: experts.map(expert => expert.slug), save: vi.fn(), refresh: vi.fn(), close: vi.fn() }
  render(<TeamEditor {...props} experts={experts} />)
  const opener = screen.getByRole('button', { name: action === 'replace' ? '替换成员 候选专家 0' : '添加成员' })
  opener.focus()
  fireEvent.click(opener)
  let picker = screen.getByRole('dialog', { name: '选择团队成员' })
  fireEvent.click(within(picker).getByRole('button', { name: '关闭' }))
  expect(document.activeElement).toBe(opener)
  expect(screen.getAllByRole('textbox', { name: '职责摘要' })).toHaveLength(count)
  fireEvent.click(opener)
  picker = screen.getByRole('dialog', { name: '选择团队成员' })
  const choice = within(picker).getByRole('button', { name: new RegExp(`^候选专家 ${count}`) })
  choice.focus()
  fireEvent.click(choice)
  expect(screen.queryByRole('dialog', { name: '选择团队成员' })).toBeNull()
  const fields = screen.getAllByRole<HTMLInputElement>('textbox', { name: '职责摘要' })
  const field = fields[action === 'replace' ? 0 : count]
  expect(document.activeElement === field).toBe(true)
  expect(field.value).toBe(action === 'replace' ? '原职责 candidate-0' : `分析资料 ${count}`)
  expect(fields[action === 'replace' ? 1 : 0].value).toBe(action === 'replace' ? '原职责 candidate-1' : '原职责 candidate-0')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '添加成员' }).disabled).toBe(action === 'eighth')
  expect(props.save).not.toHaveBeenCalled()
  expect(props.refresh).not.toHaveBeenCalled()
  expect({ focused: document.activeElement?.getAttribute('aria-label'), duty: field.value, members: fields.length }).toMatchSnapshot()
})

it('keeps remaining members visible when an open scrolled directory shrinks', () => {
  const experts: ExpertSummary[] = Array.from({ length: 40 }, (_, index) => ({
    slug: `candidate-${index}`, name: `候选专家 ${index}`, nameEn: `Candidate ${index}`,
    description: '分析资料', descriptionEn: 'Analyze sources', emoji: '🔎', division: 'research', divisionZh: '研究', custom: true,
  }))
  const props = { initial: TEST_TEAMS[0], enabled: false, enabledExperts: experts.map(expert => expert.slug),
    save: vi.fn(), refresh: vi.fn(), close: vi.fn() }
  const view = render(<TeamEditor {...props} experts={experts} />)
  fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
  const picker = screen.getByRole('dialog', { name: '选择团队成员' })
  const scroller = picker.querySelector('.agt-picker-list')
  if (!scroller) throw new Error('Missing member scroller')
  fireEvent.scroll(scroller, { target: { scrollTop: 1800 } })
  expect(within(picker).queryByRole('button', { name: /^候选专家 0/u })).toBeNull()
  view.rerender(<TeamEditor {...props} experts={experts.slice(0, 3)} />)
  const choice = within(picker).getByRole('button', { name: /^候选专家 0/u })
  fireEvent.click(choice)
  expect(screen.queryByRole('dialog', { name: '选择团队成员' })).toBeNull()
  expect(screen.getByText('候选专家 0')).toBeTruthy()
})

it('retains the focused member candidate while scrolling and removing a preceding candidate', () => {
  const experts: ExpertSummary[] = Array.from({ length: 40 }, (_, index) => ({
    slug: `candidate-${index}`, name: `候选专家 ${index}`, nameEn: `Candidate ${index}`,
    description: '分析资料', descriptionEn: 'Analyze sources', emoji: '🔎', division: 'research', divisionZh: '研究', custom: true,
  }))
  const props = { initial: TEST_TEAMS[0], enabled: false, enabledExperts: experts.map(expert => expert.slug),
    save: vi.fn(), refresh: vi.fn(), close: vi.fn() }
  const view = render(<TeamEditor {...props} experts={experts} />)
  fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
  const picker = screen.getByRole('dialog', { name: '选择团队成员' })
  const scroller = picker.querySelector('.agt-picker-list')
  if (!scroller) throw new Error('Missing member scroller')
  const choice = within(picker).getByRole('button', { name: /^候选专家 1\D/u })
  const avatar = choice.querySelector('img')
  act(() => { choice.focus() })
  fireEvent.scroll(scroller, { target: { scrollTop: 1800 } })
  expect(document.activeElement).toBe(choice)
  view.rerender(<TeamEditor {...props} experts={experts.slice(1)} />)
  expect(within(picker).getByRole('button', { name: /^候选专家 1\D/u })).toBe(choice)
  expect(choice.querySelector('img')).toBe(avatar)
  expect(document.activeElement).toBe(choice)
  expect(within(picker).queryByRole('button', { name: /^候选专家 2\D/u })).toBeNull()
  fireEvent.click(choice)
  expect(screen.queryByRole('dialog', { name: '选择团队成员' })).toBeNull()
  expect(screen.getByText('候选专家 1')).toBeTruthy()
})

it.each((['zh', 'en'] as const).flatMap(language => (['removed', 'disabled'] as const).flatMap(change =>
  [false, true].map(elsewhere => ({ language, change, elsewhere })))))(
  'recovers removed candidate focus in $language without resetting the team draft ($change, elsewhere=$elsewhere)', ({ language, change, elsewhere }) => {
    const text = (key: string) => teamText(language, key)
    const experts: ExpertSummary[] = Array.from({ length: 4 }, (_, index) => ({
      slug: `candidate-${index}`, name: `候选专家 ${index}`, nameEn: `Candidate ${index}`,
      description: '分析资料', descriptionEn: 'Analyze sources', emoji: '🔎', division: 'research', custom: true,
    }))
    const props = { initial: TEST_TEAMS[0], enabled: false, enabledExperts: experts.map(expert => expert.slug),
      save: vi.fn(), refresh: vi.fn(), close: vi.fn() }
    const view = render(<TeamLocaleContext.Provider value={language}>
      <TeamEditor {...props} experts={experts} />
    </TeamLocaleContext.Provider>)
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: text('团队名称') })
    fireEvent.change(name, { target: { value: 'Unsubmitted team draft' } })
    fireEvent.click(screen.getByRole('button', { name: text('添加成员') }))
    const picker = screen.getByRole('dialog', { name: text('选择团队成员') })
    const search = within(picker).getByRole<HTMLInputElement>('textbox', { name: text('搜索团队成员') })
    const query = language === 'zh' ? '候选专家' : 'Candidate'
    fireEvent.change(search, { target: { value: query } })
    search.setSelectionRange(1, 3)
    const choiceName = language === 'zh' ? /^候选专家 1\D/u : /^Candidate 1\D/u
    const choice = within(picker).getByRole('button', { name: choiceName })
    const other = within(picker).getByRole('button', { name: text('来源') })
    act(() => { choice.focus() })
    if (elsewhere) act(() => { other.focus() })
    view.rerender(<TeamLocaleContext.Provider value={language}><TeamEditor {...props}
      experts={change === 'removed' ? experts.filter(expert => expert.slug !== 'candidate-1') : experts}
      enabledExperts={props.enabledExperts.filter(slug => slug !== 'candidate-1')} /></TeamLocaleContext.Provider>)
    expect(within(picker).queryByRole('button', { name: choiceName })).toBeNull()
    expect(document.activeElement).toBe(elsewhere ? other : search)
    expect(within(picker).getByRole('textbox', { name: text('搜索团队成员') })).toBe(search)
    expect(search.value).toBe(query)
    expect([search.selectionStart, search.selectionEnd]).toEqual([1, 3])
    fireEvent.click(within(picker).getByRole('button', { name: text('关闭') }))
    expect(screen.getByRole('textbox', { name: text('团队名称') })).toBe(name)
    expect(name.value).toBe('Unsubmitted team draft')
    expect(props.save).not.toHaveBeenCalled()
    expect(props.refresh).not.toHaveBeenCalled()
  },
)
