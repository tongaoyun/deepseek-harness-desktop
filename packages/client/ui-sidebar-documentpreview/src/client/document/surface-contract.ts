/** Reusable previews for authorized bytes from sources outside Session files. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FactoryComponentPropsOf, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefCallback } from 'react'
import type { DocumentContent } from './contract.ts'
import type { DocumentPreviewDefinition } from './registry.ts'

/** Transient bytes borrowed read-only by the document viewer. */
export interface DocumentPreviewFile {
  readonly data: Uint8Array<ArrayBuffer>
  readonly mediaType?: string
  readonly missingFonts?: readonly string[]
}

/** Authorized source read; its owner checks current access on every invocation. */
export type DocumentPreviewSource = (signal: AbortSignal) => Promise<DocumentPreviewFile>

/** Inputs to one independently mounted, Session-free preview occurrence. */
export interface DocumentPreviewInput {
  readonly fileName: string
  readonly read: DocumentPreviewSource
  /** Office conversion reads its source after converter admission; ordinary reads are not called first. */
  readonly renderOffice?: DocumentPreviewSource
  /** Changing the revision rechecks access and discards the previous content. */
  readonly revision?: string | number
  /** Return localized public copy; the default never exposes a thrown message. */
  readonly failureText?: (error: unknown) => string
}

/** Transient content supplied to a reusable document implementation. */
export interface DocumentPreviewSurfaceOwner {
  readonly fileName: string
  readonly content: DocumentContent
  readonly signal: AbortSignal
  readonly wrap: boolean
  readonly scrollportRef: RefCallback<HTMLElement>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Independent document viewer for non-Session sources, with cancellable authorized reads. */
    'document.preview': {
      scope: 'root'
      props: DocumentPreviewInput
      locale: 'sidebarDocumentPreview'
      children: {
        'document.preview.body': { kind: 'keyed'; scope: 'root' }
        'document.preview.fonts': { kind: 'list'; scope: 'root' }
      }
      inject: { hooks: { documentPreviews: ObservableSnapshot<readonly DocumentPreviewDefinition[]> } }
    }
  }
  interface SlotMap {
    /** Implementations use the same registry ids as the ordinary Sidebar preview. */
    'document.preview.body': { kind: 'keyed'; scope: 'root'; owner: DocumentPreviewSurfaceOwner }
    /** Missing-font details from an authorized Office conversion. */
    'document.preview.fonts': { kind: 'list'; scope: 'root'; owner: { readonly fonts: readonly string[] } }
  }
}

/** Framework-derived input for the reusable viewer. */
export type DocumentPreviewSurfaceProps = FactoryComponentPropsOf<'document.preview'>

/** Framework-derived input for a reusable document body. */
export type DocumentPreviewSurfaceBodyProps = PropsRuntime<'document.preview.body'>
