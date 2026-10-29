// @vitest-environment jsdom
/** Reusable original-byte previews through the production Factory and renderer registries. */
import { useState } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import type { DocumentPreviewFile, DocumentPreviewInput, DocumentPreviewSurfaceBodyProps } from '../src/client/document/surface-contract.ts'
import { createResources, byteResult } from './fixtures.client.ts'

let runtime: SlotTestRuntime | undefined
afterEach(async () => { await runtime?.dispose(); runtime = undefined })

const original = (text: string): DocumentPreviewFile => ({ data: new TextEncoder().encode(text) })

async function boot(input: DocumentPreviewInput) {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  rt.ctx.provide('resources', createResources())
  rt.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(false) } } as never)
  rt.ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
  rt.ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }, read: () => undefined } satisfies import('@deepseek-ai/cordis').Context['fileDrag'])
  const workspaceRead = vi.fn()
  const workspaceBytes = vi.fn(async () => byteResult())
  rt.remote.provideNamespaces({ workspaceFiles: { read: workspaceRead, readBytes: workspaceBytes } })
  const fiber = await rt.mount({ inject: [...inject], apply })
  let update: (next: DocumentPreviewInput | undefined) => void = () => { throw new Error('Root has not rendered.') }
  await rt.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => {
    const [current, setCurrent] = useState<DocumentPreviewInput | undefined>(input)
    update = setCurrent
    return current === undefined ? null : renderFactorySlot('document.preview', current)
  })
  const view = rt.renderRoot()
  return { rt, fiber, view, update, workspaceRead, workspaceBytes }
}

describe('original-byte document Factory', () => {
  it('opens the original Markdown without any mounted Session or workspace read', async () => {
    const read = vi.fn(async (_signal: AbortSignal) => original('# Original file\n\nA complete paragraph.'))
    const h = await boot({ fileName: 'guide.md', read })
    await waitFor(() => { expect(h.view.getByRole('heading', { name: 'Original file' })).toBeTruthy() })
    expect(h.view.container.querySelector('[data-document-markdown]')?.textContent).toContain('A complete paragraph.')
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    expect(h.workspaceRead).not.toHaveBeenCalled()
    expect(h.workspaceBytes).not.toHaveBeenCalled()
  })

  it('clears old bytes, aborts replaced reads and rejects stale completion', async () => {
    const pending = Promise.withResolvers<DocumentPreviewFile>()
    const read = vi.fn(async (_signal: AbortSignal) => pending.promise)
    const h = await boot({ fileName: 'old.txt', read })
    const signal = read.mock.calls[0]?.[0]
    await act(async () => { h.update({ fileName: 'new.txt', read: async () => original('New original content') }) })
    expect(signal?.aborted).toBe(true)
    await waitFor(() => { expect(h.view.container.textContent).toContain('New original content') })
    await act(async () => { pending.resolve(original('Stale private document')) })
    expect(h.view.container.textContent).not.toContain('Stale private document')
  })

  it('rechecks access on refresh and never retains bytes beneath a permission failure', async () => {
    const read = vi.fn(async (_signal: AbortSignal) => original('Private document'))
    const h = await boot({ fileName: 'note.txt', read, revision: 1, failureText: () => 'Access revoked' })
    await waitFor(() => { expect(h.view.container.textContent).toContain('Private document') })
    read.mockRejectedValueOnce(new Error('sensitive upstream diagnostic'))
    await act(async () => { h.update({ fileName: 'note.txt', read, revision: 2, failureText: () => 'Access revoked' }) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Access revoked') })
    expect(h.view.container.textContent).not.toContain('Private document')
    expect(h.view.container.textContent).not.toContain('sensitive upstream diagnostic')
    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/u }))
    await waitFor(() => { expect(h.view.container.textContent).toContain('Private document') })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('converts Office through the authorized converter without reading source bytes first', async () => {
    const read = vi.fn(async (_signal: AbortSignal) => original('never preload queued Office input'))
    const renderOffice = vi.fn(async (_signal: AbortSignal) => original('%PDF converted original'))
    const h = await boot({ fileName: 'document.docx', read, renderOffice })
    const definition = h.rt.ctx.documentPreviews.register({ id: 'test-office', extensions: ['docx'], loading: 'bytes-complete', title: () => 'Test Office' })
    const body = h.rt.slots.register({ name: 'document.preview.body', key: 'test-office' }, (props: DocumentPreviewSurfaceBodyProps) => {
      expect(props).not.toHaveProperty('sessionId')
      return <span>{props.content.kind === 'bytes' ? new TextDecoder().decode(props.content.data) : ''}</span>
    })
    await waitFor(() => { expect(h.view.container.textContent).toContain('%PDF converted original') })
    expect(read).not.toHaveBeenCalled()
    expect(renderOffice).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    body(); definition()
  })

  it('blocks unsupported binary and invalid text without displaying lossy bytes', async () => {
    const read = vi.fn(async (_signal: AbortSignal) => ({ data: new Uint8Array([255, 0, 254]) }))
    const h = await boot({ fileName: 'archive.zip', read })
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(read).not.toHaveBeenCalled()
    await act(async () => { h.update({ fileName: 'bad.txt', read }) })
    await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(h.view.container.textContent).not.toContain('\uFFFD')
  })

  it('uses the native static HTML sandbox without scripts or parent-origin permissions', async () => {
    const read = async () => original('<html><head><script>window.secret = "do-not-run"</script></head><body><h1>Original page</h1><a href="https://example.test/secret">Link</a></body></html>')
    const h = await boot({ fileName: 'original.html', read })
    await waitFor(() => { expect(h.view.container.querySelector('iframe[data-html-preview]')).not.toBeNull() })
    const frame = h.view.container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.srcdoc).not.toContain('<script')
    expect(frame.srcdoc).not.toContain('href=')
    expect(frame.srcdoc).toContain("script-src 'none'")
    expect(frame.srcdoc).toContain("connect-src 'none'")
    expect(frame.srcdoc).toContain('Original page')
  })

  it('keeps source failure diagnostics private when no public error translator is supplied', async () => {
    const h = await boot({ fileName: 'private.pdf', read: async () => { throw new Error('employee-token=private-secret; /private/server/path') } })
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(h.view.container.textContent).not.toContain('private-secret')
    expect(h.view.container.textContent).not.toContain('/private/server/path')
    expect(h.view.container.textContent).toMatch(/无法读取文件|Unable to read the file/u)
  })

  it('aborts in-flight reads when the preview closes and removes its Factory on unload', async () => {
    const pending = Promise.withResolvers<DocumentPreviewFile>()
    const read = vi.fn(async (_signal: AbortSignal) => pending.promise)
    const h = await boot({ fileName: 'pending.txt', read })
    const signal = read.mock.calls[0]?.[0]
    await act(async () => { h.update(undefined) })
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(original('Do not display after close')) })
    expect(h.view.container.textContent).not.toContain('Do not display after close')
    await h.fiber.dispose()
    expect(() => h.rt.factoryOf('document.preview')).toThrow('no definition')
  })
})
