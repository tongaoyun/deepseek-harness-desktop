/** Text preview stand-in for product authorization and cancellation tests. */
import { useEffect, useState } from 'react'
import type { DocumentPreviewInput } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { RenderFactorySlot } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { zh } from '../src/locales.ts'
import { markdownLabels } from '../src/client/catalog-shared.tsx'

export const renderKnowledgePreview: RenderFactorySlot = (name, props) => {
  if (name !== 'document.preview') throw new Error('Unexpected preview factory')
  return <Preview input={props as DocumentPreviewInput} />
}

function Preview({ input }: { readonly input: DocumentPreviewInput }) {
  const [content, setContent] = useState<string>()
  const [failure, setFailure] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setContent(undefined); setFailure('')
    const read = /\.(doc|docx|ppt|pptx)$/iu.test(input.fileName) && input.renderOffice ? input.renderOffice : input.read
    void read(controller.signal).then((file) => {
      if (!controller.signal.aborted) setContent(new TextDecoder().decode(file.data))
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(input.failureText?.(error) ?? 'Preview failed')
    })
    return () => { controller.abort() }
  }, [input.fileName, input.read, input.renderOffice, input.revision, revision, input.failureText])
  return <div data-original-preview={input.fileName}>
    {failure && <><p role="alert">{failure}</p><button type="button" onClick={() => { setRevision(value => value + 1) }}>{zh.retry}</button></>}
    {content !== undefined && <MarkdownText text={content} labels={markdownLabels(key => zh[key])} />}
  </div>
}

export function originalPreview(text: string, mediaType = 'text/markdown') {
  return { mediaType, data: Uint8Array.from(new TextEncoder().encode(text)) }
}

export function originalMetadata(knowledgeBaseId: string, documentId: string, filename = '业务规范.md', sourceType = 'file') {
  return { id: documentId, knowledgeBaseId, filename, sourceType, mediaType: 'application/octet-stream', sizeBytes: 120,
    status: 'FAILED', chunkCount: 0, updatedAt: '2026-10-10T00:00:00Z',
    previewMaxBytes: 50 * 1024 * 1024, downloadMaxBytes: 250 * 1024 * 1024, uploadMaxBytes: 50 * 1024 * 1024 }
}

/** Adapt file fixtures to the chunked wire protocol without concealing call assertions. */
export function createPreviewFixture() {
  const files = new Map<string, { readonly data: Uint8Array; readonly mediaType: string }>()
  let next = 0
  return async (method: string, payload: unknown, read: (method: string, payload: unknown) => Promise<unknown>): Promise<unknown> => {
    if (method === 'knowledge.documents.preview.read') {
      if (typeof payload !== 'object' || payload === null || !('transferId' in payload) || !('offset' in payload)) throw new Error('Invalid fixture read')
      const file = files.get(String(payload.transferId))
      if (file === undefined) throw new Error('Missing fixture transfer')
      const offset = Number(payload.offset)
      const data = file.data.slice(offset, offset + 256 * 1024)
      return { data, offset, eof: offset + data.byteLength === file.data.byteLength }
    }
    if (method === 'knowledge.documents.preview.close') {
      if (typeof payload === 'object' && payload !== null && 'transferId' in payload) files.delete(String(payload.transferId))
      return { closed: true }
    }
    const value = await read(method, payload)
    if (method !== 'knowledge.documents.preview.open') return value
    const file = originalFromFixture(value)
    if (typeof file !== 'object' || file === null || !('data' in file) || !(file.data instanceof Uint8Array)
      || !('mediaType' in file) || typeof file.mediaType !== 'string') throw new Error('Invalid fixture file')
    const transferId = `fixture-${++next}`
    files.set(transferId, { data: file.data, mediaType: file.mediaType })
    return { transferId, fileName: 'fixture.md', mediaType: file.mediaType, byteLength: file.data.byteLength,
      maxBytes: 50 * 1024 * 1024, chunkSize: 256 * 1024 }
  }
}

export function originalFromFixture(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)) return value
  return originalPreview(value.items.map((row: unknown) => typeof row === 'object' && row !== null && 'content' in row
    && typeof row.content === 'string' ? row.content : '').join('\n\n'))
}
