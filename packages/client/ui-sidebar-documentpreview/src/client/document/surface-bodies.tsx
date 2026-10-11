/** Session-free adapters reuse the Sidebar's native document renderers. */
import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { ImageDocumentView } from '../image/ImageBody.tsx'
import { MarkdownDocumentView } from '../markdown/MarkdownBody.tsx'
import { TextDocumentView } from '../text/TextBody.tsx'
import { CodeDocumentView } from '../code/CodeBody.tsx'
import { BasicHtmlFrame } from '../html/HtmlBody.tsx'
import { ZoomViewport, zoomSurfaceClass } from '../zoom/ZoomViewport.tsx'
import { FIT_WIDTH, type ZoomPreference } from '../zoom/types.ts'
import { excelFormat } from '../excel/format.ts'
import type { ExcelLimits } from '../excel/model.ts'
import type { PdfView } from '../pdf/store.ts'
import type { DocumentPreviewSurfaceBodyProps } from './surface-contract.ts'

const PdfDocumentView = lazy(async () => ({ default: (await import('../pdf/pdf.tsx')).PdfDocumentView }))
const ExcelBody = lazy(async () => ({ default: (await import('../excel/excel.tsx')).ExcelBody }))

/** @param props - authorized complete PDF bytes and locale. @returns the ordinary native PDF viewer. */
export function SurfacePdf(props: DocumentPreviewSurfaceBodyProps & PropsLocale<'sidebarPdf'>): ReactNode {
  const [view, setView] = useState<PdfView>({ page: 1 })
  const onPage = useCallback((page: number): void => { setView(current => ({ ...current, page })) }, [])
  const onZoom = useCallback((zoom: ZoomPreference): void => { setView(current => ({ ...current, zoom })) }, [])
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <PdfDocumentView data={props.content.kind === 'bytes' ? props.content.data : undefined}
      signal={props.signal} view={view} onPage={onPage} onZoom={onZoom} scrollportRef={props.scrollportRef}
      ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass} t={props.t} loading={loading} />
  </Suspense>
}

/** @param props - authorized spreadsheet bytes and configured parser limits. @returns the ordinary read-only workbook. */
export function SurfaceExcel(props: DocumentPreviewSurfaceBodyProps & PropsLocale<'sidebarExcel'> & { readonly limits: ExcelLimits }): ReactNode {
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <ExcelBody content={props.content} format={excelFormat(props.fileName)} limits={props.limits}
      signal={props.signal} t={props.t} loading={loading} />
  </Suspense>
}

/** @param props - authorized complete image bytes and locale. @returns the ordinary image viewer. */
export function SurfaceImage(props: DocumentPreviewSurfaceBodyProps & PropsLocale<'sidebarImage'>): ReactNode {
  const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH)
  return <ImageDocumentView data={props.content.kind === 'bytes' ? props.content.data : undefined}
    path={props.fileName} preference={preference} onPreference={setPreference} signal={props.signal}
    scrollportRef={props.scrollportRef} t={props.t} />
}

/** @param props - complete decoded source and locale. @returns the ordinary Markdown renderer without unauthorized related-file reads. */
export function SurfaceMarkdown(props: DocumentPreviewSurfaceBodyProps & PropsLocale<'documentMarkdown'>): ReactNode {
  return <MarkdownDocumentView content={props.content} t={props.t} />
}

/** @param props - complete decoded source. @returns the ordinary plain-text renderer. */
export function SurfaceText(props: DocumentPreviewSurfaceBodyProps): ReactNode {
  return <TextDocumentView content={props.content} />
}

/** @param props - complete decoded source and locale. @returns the ordinary highlighted source renderer. */
export function SurfaceCode(props: DocumentPreviewSurfaceBodyProps & PropsLocale<'sidebarCodePreview'>): ReactNode {
  return <CodeDocumentView fileName={props.fileName} content={props.content} wrap={props.wrap}
    scrollportRef={props.scrollportRef} t={props.t} />
}

/** @param props - complete authorized HTML bytes and locale. @returns the ordinary sanitized static HTML frame. */
export function SurfaceHtml(props: DocumentPreviewSurfaceBodyProps & PropsLocale<'documentHtml'>): ReactNode {
  if (props.content.kind !== 'bytes') return null
  return <BasicHtmlFrame data={props.content.data} frameName="dsh-document-preview" t={props.t} />
}
