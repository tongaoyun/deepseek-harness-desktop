// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SkillBody } from '../src/skill-body.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const t = (key: string): string => key

it.each(['denied', 'missing'] as const)('keeps the body readable when the clipboard is %s', async (reason) => {
  vi.stubGlobal('navigator', reason === 'denied'
    ? { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) } } : {})
  render(createElement(SkillBody, { body: 'Keep this text.', t }))
  fireEvent.click(screen.getByRole('button', { name: 'detail.copyBody' }))
  await screen.findByRole('button', { name: 'detail.copyFailed' })
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Keep this text.')
  expect(screen.queryByRole('button', { name: 'detail.copied' })).toBeNull()
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
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'detail.copying' }).disabled).toBe(true)
  view.rerender(createElement(SkillBody, { body: 'Second body', t }))
  await act(async () => { finish(); await pending })
  expect(screen.queryByRole('button', { name: 'detail.copied' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'detail.copyBody' }))
  await screen.findByRole('button', { name: 'detail.copied' })
  expect(writeText).toHaveBeenLastCalledWith('Second body')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Second body')
})
