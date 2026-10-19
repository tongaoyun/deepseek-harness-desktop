// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionImportPreview } from '@deepseek-harness/product/extension-draft'
import { ExtensionPreview } from '../src/client/ExtensionPreview.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const preview: ExtensionImportPreview = {
  stageId: '00000000-0000-4000-8000-000000000001', missingFields: [], files: [{ path: 'SKILL.md', bytes: 40 }],
  draft: { kind: 'skill', id: 'review-policy', name: 'Review policy', summary: 'Review facts', version: '1.0.0',
    category: 'legal', triggers: ['Policy review'], body: 'Retained Markdown' },
}
const saved = { kind: 'skill', id: 'review-policy', version: '1.0.0', visibility: 'PERSONAL', installed: true }
const props = () => ({ preview, t: (key: keyof typeof zh) => zh[key],
  onClose: vi.fn(), onSaved: vi.fn(), onContinue: vi.fn(async () => {}) })

it('leaves import staging with its owner during StrictMode replay', () => {
  const invoke = vi.fn(async () => ({ ok: true, result: {} }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<StrictMode><ExtensionPreview {...props()} /></StrictMode>)
  expect(invoke).not.toHaveBeenCalled()
  view.unmount()
  expect(invoke).not.toHaveBeenCalled()
})

it.each(['header', 'escape', 'mask'] as const)('keeps the import open on %s close while saving, then allows closing after failure', async (action) => {
  let finish!: (value: unknown) => void
  const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const handlers = props()
  render(<ExtensionPreview {...handlers} />)
  fireEvent.click(screen.getByRole('button', { name: zh.saveAndInstall }))
  const close = () => {
    if (action === 'header') fireEvent.click(screen.getAllByRole('button', { name: zh.close })[0]!)
    else if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    else fireEvent.click(document.querySelector('[role="presentation"] > [aria-hidden="true"]')!)
  }
  close()
  expect(handlers.onClose).not.toHaveBeenCalled()
  await act(async () => { finish({ ok: true, result: {} }) })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByText('Retained Markdown')).toBeTruthy()
  close()
  expect(handlers.onClose).toHaveBeenCalledOnce()
})

it.each([undefined, {}, { ...saved, id: 'another-skill' }, { ...saved, version: '2.0.0' },
  { ...saved, kind: 'expert-kit' }, { ...saved, visibility: 'COMPANY' }, { ...saved, installed: false },
  { ...saved, installed: 'true' }])('retains the preview after an unconfirmed save receipt: %j', async (receipt) => {
  const invoke = vi.fn(async () => ({ ok: true, result: receipt }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const handlers = props()
  render(<ExtensionPreview {...handlers} />)
  fireEvent.click(screen.getByRole('button', { name: zh.saveAndInstall }))
  await screen.findByRole('alert')
  expect(handlers.onSaved).not.toHaveBeenCalled()
  expect(screen.getByText('Retained Markdown')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveAndInstall }).disabled).toBe(false)
})

it('saves using the import stage even when the draft does not repeat it', async () => {
  const invoke = vi.fn(async () => ({ ok: true, result: saved }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const handlers = props()
  render(<ExtensionPreview {...handlers} />)
  fireEvent.click(screen.getByRole('button', { name: zh.saveAndInstall }))
  await act(async () => {})
  expect(invoke).toHaveBeenCalledWith('product', 'extensions.save', expect.objectContaining({ stageId: preview.stageId }), expect.any(String))
  expect(handlers.onSaved).toHaveBeenCalledOnce()
})

it('accepts a saved expert kit without requiring automatic installation', async () => {
  const kit: ExtensionImportPreview = { ...preview, draft: { ...preview.draft, kind: 'expert-kit', id: 'review-kit',
    skills: [{ id: 'review-policy', name: 'Review', summary: 'Review facts', body: 'Read first',
      triggers: ['Policy review'], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }] } }
  const invoke = vi.fn(async () => ({ ok: true, result: { ...saved, kind: 'expert-kit', id: 'review-kit', installed: false } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const handlers = props()
  render(<ExtensionPreview {...handlers} preview={kit} />)
  fireEvent.click(screen.getByRole('button', { name: zh.savePersonal }))
  await act(async () => {})
  expect(handlers.onSaved).toHaveBeenCalledOnce()
})

it('cancels an abandoned save and ignores its late successful receipt', async () => {
  let finish!: (value: unknown) => void
  const invoke = vi.fn((_namespace: string, _method: string, _payload: unknown, _requestId: string) =>
    new Promise((resolve) => { finish = resolve }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const handlers = props()
  const view = render(<ExtensionPreview {...handlers} />)
  fireEvent.click(screen.getByRole('button', { name: zh.saveAndInstall }))
  view.unmount()
  expect(cancel).toHaveBeenCalledWith('product', invoke.mock.calls[0]![3])
  await act(async () => { finish({ ok: true, result: saved }) })
  expect(handlers.onSaved).not.toHaveBeenCalled()
})
