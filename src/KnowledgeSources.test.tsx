// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeSources } from './KnowledgeSources'
import { loadKnowledgeSource } from './api'
import type { KnowledgeSearchHit } from './types'

vi.mock('./api', () => ({ loadKnowledgeSource: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const hit: KnowledgeSearchHit = { sourceId: '123e4567-e89b-12d3-a456-426614174000', knowledgeBaseId: 'kb', knowledgeBaseName: '制度', documentId: 'doc', filename: '报销.md', locator: '正文', content: '历史摘录', score: 1 }
const context = { endpoint: '/knowledge', employeeId: 'one', teamId: '', accessToken: '' }
beforeEach(() => vi.resetAllMocks())

it('rereads current evidence on every open, never falls back to a deleted historical excerpt', async () => {
  const element = document.body.appendChild(document.createElement('div')); const root = createRoot(element)
  try {
    await act(async () => root.render(<KnowledgeSources sources={[hit]} context={context} />))
    vi.mocked(loadKnowledgeSource).mockResolvedValue({ ...hit, content: '当前原文' })
    await act(async () => element.querySelector('button')!.click())
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('当前原文')
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('历史摘录')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭原文"]')!.click())
    vi.mocked(loadKnowledgeSource).mockRejectedValue(new Error('原文已删除，请重新检索'))
    await act(async () => element.querySelector('button')!.click())
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('原文已删除')
    expect(document.querySelector('[role="dialog"] pre')).toBeNull()
    expect(loadKnowledgeSource).toHaveBeenCalledTimes(2)
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('aborts old account reads and ignores late results after switching account', async () => {
  let finish!: (hit: KnowledgeSearchHit) => void
  vi.mocked(loadKnowledgeSource).mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValue({ ...hit, content: '新账号原文' })
  const element = document.body.appendChild(document.createElement('div')); const root = createRoot(element)
  try {
    await act(async () => root.render(<KnowledgeSources sources={[hit]} context={context} />))
    await act(async () => element.querySelector('button')!.click())
    const signal = vi.mocked(loadKnowledgeSource).mock.calls[0][2]!
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    await act(async () => root.render(<KnowledgeSources sources={[hit]} context={{ ...context, employeeId: 'two' }} />))
    await act(async () => finish({ ...hit, content: '旧账号原文' }))
    expect(signal.aborted).toBe(true)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('新账号原文')
    expect(document.body.textContent).not.toContain('旧账号原文')
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('does not invent clickable source identities for historical records', async () => {
  const element = document.body.appendChild(document.createElement('div')); const root = createRoot(element)
  try {
    await act(async () => root.render(<KnowledgeSources sources={[{ ...hit, sourceId: undefined }]} context={context} />))
    expect(element.querySelector('button')!.disabled).toBe(true)
    expect(loadKnowledgeSource).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); element.remove() }
})
