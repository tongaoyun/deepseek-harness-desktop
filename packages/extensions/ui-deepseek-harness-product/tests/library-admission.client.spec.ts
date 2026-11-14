// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { InputHub } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/hub.ts'
import { ComposerBlockRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/blocks.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { createHarnessActions } from '../src/client/harness-actions.ts'
import { LibraryEntrySchema } from '@deepseek-harness/product/library'
const file = LibraryEntrySchema.parse({ id: '22222222-2222-4222-8222-222222222222', libraryId: '11111111-1111-4111-8111-111111111111',
  parentId: null, name: '中文资料.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 3, favorite: false,
  version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' })
async function fixture() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  onTestFinished(() => { vi.unstubAllGlobals() })
  const upload = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'library-receipt' as never,
    file: { attachmentId: 'sha256:library-file' as never, name: file.name, bytes: 3 } } }))
  runtime.fileUpload.upload = upload
  await runtime.sessions.add({ id: 'library-session' })
  const reference = runtime.sessions.retain('library-session' as never)
  await reference.ready
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, { input: hub, blocks: new ComposerBlockRegistry(), maxConcurrentFileUploads: 2 })
  await fiber.await()
  const conversation = runtime.ctx.get('conversation') as ConversationController
  const binding = runtime.sessions.binding('library-session')
  if (!binding) throw new Error('Missing Session')
  const shell = hub.shellFor(binding)
  shell.setDraft('保留草稿')
  return { runtime, upload, conversation, binding, shell }
}
it('uses native draft admission and upload without replacing text, and releases rejected drafts', async () => {
  const { runtime, upload, conversation, binding, shell } = await fixture()
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true, result:
    method === 'library.files.preview.open' ? { transferId: 'transfer', fileName: file.name, mediaType: file.mediaType, byteLength: 3, maxBytes: 1024, chunkSize: 1024 }
      : method === 'library.files.preview.read' ? { data: new Uint8Array([65, 66, 67]), offset: 0, eof: true } : { closed: true } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: () => {}, subscribe: () => () => {} } })
  await createHarnessActions(runtime.ctx).attachLibraryFiles(binding.session.sessionId, [file], new AbortController().signal)
  expect(shell.snapshot.draft).toBe('保留草稿')
  expect(shell.snapshot.attachmentIds).toHaveLength(1)
  const [draft] = conversation.resolveDraftAttachments(shell.snapshot.attachmentIds)
  expect(draft).toMatchObject({ kind: 'file', file: { name: file.name, size: 3 } })
  await vi.waitFor(() =>{  expect(conversation.fileUploads.getSnapshot()[draft!.id]?.status).toBe('ready') })
  expect(upload).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.map(call => call[1])).toEqual(['library.files.preview.open', 'library.files.preview.read', 'library.files.preview.close', 'library.entries.access'])
  const release = vi.spyOn(conversation, 'releaseDraftAttachments')
  vi.spyOn(shell, 'addAttachments').mockReturnValueOnce(false)
  await expect(createHarnessActions(runtime.ctx).attachLibraryFiles(binding.session.sessionId, [file], new AbortController().signal)).rejects.toThrow('busy')
  expect(release).toHaveBeenCalledOnce()
  expect(shell.snapshot.attachmentIds).toHaveLength(1)
})

it.each(['count', 'bytes'] as const)('rejects excessive library attachment %s before reading private files or changing the draft', async (limit) => {
  const { runtime, upload, binding, shell } = await fixture()
  const invoke = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: () => {}, subscribe: () => () => {} } })
  const files = limit === 'count'
    ? Array.from({ length: 21 }, (_, index) => ({ ...file, id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}` }))
    : [{ ...file, sizeBytes: 100 * 1024 * 1024 + 1 }]
  await expect(createHarnessActions(runtime.ctx).attachLibraryFiles(binding.session.sessionId, files,
    new AbortController().signal)).rejects.toThrow('Invalid attachment selection')
  expect(invoke).not.toHaveBeenCalled()
  expect(upload).not.toHaveBeenCalled()
  expect(shell.snapshot.draft).toBe('保留草稿')
  expect(shell.snapshot.attachmentIds).toHaveLength(0)
})

it.each(['open', 'read'] as const)('releases the transfer after attachment %s is cancelled without changing the draft', async (phase) => {
  const { runtime, upload, binding, shell } = await fixture()
  const late = Promise.withResolvers<unknown>()
  const descriptor = { transferId: 'cancelled-transfer', fileName: file.name, mediaType: file.mediaType,
    byteLength: 3, maxBytes: 1024, chunkSize: 1024 }
  const chunk = { data: new Uint8Array([65, 66, 67]), offset: 0, eof: true }
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true, result:
    method === `library.files.preview.${phase}` ? await late.promise
      : method === 'library.files.preview.open' ? descriptor
        : method === 'library.files.preview.read' ? chunk : { closed: true } }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel, subscribe: () => () => {} } })
  onTestFinished(() => { late.resolve(phase === 'open' ? descriptor : chunk) })
  const controller = new AbortController()
  const attaching = createHarnessActions(runtime.ctx).attachLibraryFiles(binding.session.sessionId, [file], controller.signal)
  const failed = expect(attaching).rejects.toThrow('Attachment picker closed')
  await vi.waitFor(() => { expect(invoke.mock.calls.some(([, method]) => method === `library.files.preview.${phase}`)).toBe(true) })
  controller.abort(new Error('Attachment picker closed'))
  await failed
  expect(cancel).toHaveBeenCalledOnce()
  late.resolve(phase === 'open' ? descriptor : chunk)
  await vi.waitFor(() => { expect(invoke.mock.calls.filter(([, method]) => method === 'library.files.preview.close')).toHaveLength(1) })
  expect(shell.snapshot.draft).toBe('保留草稿')
  expect(shell.snapshot.attachmentIds).toHaveLength(0)
  expect(upload).not.toHaveBeenCalled()
})
