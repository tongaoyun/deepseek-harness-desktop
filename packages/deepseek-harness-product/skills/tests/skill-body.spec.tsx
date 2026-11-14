// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SkillBody } from '../src/skill-body.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const t = (key: string): string => key

it.each((['accepted', 'refused', 'thrown'] as const).flatMap(outcome =>
  (['copy', 'body', 'elsewhere'] as const).map(origin => ({ outcome, origin }))))(
  'retains $origin focus when native clipboard fallback is $outcome', async ({ outcome, origin }) => {
    vi.stubGlobal('navigator', {})
    const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const exec = vi.fn(() => {
      if (outcome === 'thrown') throw new Error('Clipboard unavailable')
      return outcome === 'accepted'
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    onTestFinished(() => {
      if (previous) Object.defineProperty(document, 'execCommand', previous)
      else Reflect.deleteProperty(document, 'execCommand')
    })
    // jsdom selects text without focusing; Chromium's fallback also focuses the temporary textarea.
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) { this.focus() })
    render(createElement('div', null, createElement(SkillBody, { body: 'Copy this exact body.', t }),
      createElement('button', null, 'Elsewhere')))
    const copy = screen.getByRole('button', { name: 'detail.copyBody' })
    const body = screen.getByRole<HTMLTextAreaElement>('textbox')
    body.setSelectionRange(2, 9); body.scrollTop = 32
    const focused = origin === 'copy' ? copy : origin === 'body' ? body : screen.getByRole('button', { name: 'Elsewhere' })
    focused.focus()
    fireEvent.click(copy)
    expect(document.activeElement).toBe(focused)
    const notice = await screen.findByRole(outcome === 'accepted' ? 'status' : 'alert')
    expect(notice.textContent).toBe(outcome === 'accepted' ? 'detail.copied' : 'detail.copyFailed')
    expect(exec).toHaveBeenCalledExactlyOnceWith('copy')
    expect(screen.getByRole('button', { name: 'detail.copyBody' })).toBe(copy)
    expect(screen.getByRole('textbox')).toBe(body)
    expect([body.selectionStart, body.selectionEnd, body.scrollTop]).toEqual([2, 9, 32])
    expect(document.activeElement).toBe(focused)
    expect(document.querySelector('body > textarea[readonly]')).toBeNull()
    if (origin === 'body' && outcome === 'accepted') expect({ label: copy.textContent,
      feedback: notice.textContent, focused: document.activeElement === body,
      selection: [body.selectionStart, body.selectionEnd] }).toMatchSnapshot('Native fallback result')
  },
)

it.each(['denied', 'missing'] as const)('keeps the body readable when the clipboard is %s', async (reason) => {
  vi.stubGlobal('navigator', reason === 'denied'
    ? { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) } } : {})
  render(createElement(SkillBody, { body: 'Keep this text.', t }))
  fireEvent.click(screen.getByRole('button', { name: 'detail.copyBody' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe('detail.copyFailed')
  expect(screen.getByRole('button', { name: 'detail.copyBody' })).toHaveProperty('disabled', false)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Keep this text.')
  expect(screen.queryByRole('status')).toBeNull()
})

it('does not replace the clipboard with an empty body', () => {
  const writeText = vi.fn()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(createElement(SkillBody, { body: '', t }))
  expect(screen.queryByRole('button')).toBeNull()
  expect(writeText).not.toHaveBeenCalled()
})

it('ignores an old clipboard receipt after the displayed body changes', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const writeText = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const view = render(createElement(SkillBody, { body: 'First body', t }))
  const button = screen.getByRole('button', { name: 'detail.copyBody' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(writeText).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'detail.copyBody' })).toBe(button)
  expect(button).toHaveProperty('disabled', false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.classList.contains('product-control-pending')).toBe(true)
  expect(button.textContent).toBe('detail.copyBody')
  expect({ label: button.textContent, busy: button.getAttribute('aria-busy'),
    preservesAppearance: button.classList.contains('product-control-pending') }).toMatchSnapshot('Pending copy')
  view.rerender(createElement(SkillBody, { body: 'Second body', t }))
  await act(async () => { finish(); await pending })
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'detail.copyBody' }))
  expect((await screen.findByRole('status')).textContent).toBe('detail.copied')
  expect(writeText).toHaveBeenLastCalledWith('Second body')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Second body')
})

it('retains clipboard failure feedback and button focus while a single retry is pending', async () => {
  let finish!: () => void
  const retry = new Promise<void>((resolve) => { finish = resolve })
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockReturnValueOnce(retry)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(createElement(SkillBody, { body: 'Copy this exact body.', t }))
  const button = screen.getByRole('button', { name: 'detail.copyBody' })
  button.focus()
  fireEvent.click(button)
  const notice = await screen.findByRole('alert')
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(writeText).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(document.activeElement).toBe(button)
  expect(button).toHaveProperty('disabled', false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { finish(); await retry })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('detail.copied')
  expect(screen.getByRole('button', { name: 'detail.copyBody' })).toBe(button)
  expect(button).toHaveProperty('disabled', false)
})
