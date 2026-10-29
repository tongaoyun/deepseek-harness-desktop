/** PDF page presentation; binary content and tab information come from the document owner. */
import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type RefCallback } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type { PdfStore, PdfView } from './store.ts'
import { renderPdfPage, type PdfDocument } from './document.ts'
import { openPdf } from './runtime.ts'
import { PdfWorkerFailure } from './errors.ts'
import { pdfTextRenderer } from './text.ts'
import type { ZoomViewportProps } from '../zoom/ZoomViewport.tsx'
import type { ZoomLabels, ZoomPreference } from '../zoom/types.ts'
import type {} from './locales.ts'
import css from './PdfBody.module.css'

/** A record's viewing preferences survive body unmounts and leave with the tab. */
export interface PdfBodyInjected {
  /**
   * Retain viewing preferences until the tab record ends.
   * @param tabId - owning tab.
   * @param signal - tab-record lifetime, not body visibility.
   */
  readonly retainTab: (tabId: TabId, signal: AbortSignal) => void
  /** Main-bundle viewport reused by the lazy PDF body. */
  readonly ZoomViewport: ComponentType<ZoomViewportProps>
  /** Main-bundle class implementing fit-width and fixed-size surfaces. */
  readonly zoomSurfaceClass: string
}

/** Standard document props plus the PDF entry's locale, viewing store, and lifetime callback. */
export type PdfBodyProps = DocumentPreviewProps & PropsLocale<'sidebarPdf'> & PropsStore<PdfStore> & PdfBodyInjected

/** PDF rendering inputs independent of a Session or Sidebar tab. */
export interface PdfDocumentProps extends PropsLocale<'sidebarPdf'> {
  readonly data: Uint8Array<ArrayBuffer> | undefined
  readonly signal: AbortSignal
  readonly view: PdfView
  readonly onPage: (page: number) => void
  readonly onZoom: (zoom: ZoomPreference) => void
  readonly scrollportRef: RefCallback<HTMLElement>
  readonly ZoomViewport: ComponentType<ZoomViewportProps>
  readonly zoomSurfaceClass: string
  readonly loading: ReactNode
}

type LoadState =
  | { readonly kind: 'loaded'; readonly data: Uint8Array<ArrayBuffer>; readonly document: PdfDocument }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly error: unknown }

const DEFAULT_PDF_VIEW: PdfView = { page: 1 }
const FIT_WIDTH: ZoomPreference = { kind: 'fit-width' }
/**
 * Present a PDF with tab-local viewing preferences and component-owned rendering resources.
 * @param props - complete bytes, framework-owned tab/store/locale seats, and main-bundle loading content.
 * @returns the PDF reader.
 */
export function PdfBody(props: PdfBodyProps & { readonly loading: ReactNode }): ReactNode {
  const { tab } = props.useTabInfo()
  const view = props.useStore(state => state.byTab[tab.id] ?? DEFAULT_PDF_VIEW)
  const pageVisible = useCallback((page: number): void => {
    props.actions.page(tab.id, page)
  }, [props.actions, tab.id])
  const setPreference = useCallback((value: ZoomPreference): void => {
    props.actions.zoom(tab.id, value)
  }, [props.actions, tab.id])
  const { retainTab } = props
  useEffect(() => { retainTab(tab.id, tab.signal) }, [retainTab, tab.id, tab.signal])
  return <PdfDocumentView data={props.content.kind === 'bytes' ? props.content.data : undefined}
    signal={tab.signal} view={view} onPage={pageVisible} onZoom={setPreference}
    scrollportRef={props.scrollportRef} ZoomViewport={props.ZoomViewport}
    zoomSurfaceClass={props.zoomSurfaceClass} loading={props.loading} t={props.t} />
}

/** @param props - complete PDF bytes and caller-owned viewing preferences. @returns the shared PDF reader. */
export function PdfDocumentView({
  data, signal, view, onPage, onZoom, scrollportRef, t, ZoomViewport, zoomSurfaceClass, loading,
}: PdfDocumentProps): ReactNode {
  const [load, setLoad] = useState<LoadState>()
  const [attempt, setAttempt] = useState(0)
  const [pageWidth, setPageWidth] = useState<number>()
  const [renderZoom, setRenderZoom] = useState(1)
  const preference = view.zoom ?? FIT_WIDTH
  const labels: ZoomLabels = {
    controls: t('zoomControls'), menu: t('zoomMenu'), out: t('zoomOut'), into: t('zoomIn'),
    fitWidth: t('zoomFitWidth'), value: percent => t('zoomValue', { percent }),
  }
  useEffect(() => {
    if (data === undefined || signal.aborted) return
    const lifetime = new AbortController()
    const reading = AbortSignal.any([lifetime.signal, signal])
    setLoad(undefined)
    const session = openPdf(data, reading, (error) => {
      if (!reading.aborted) setLoad({ kind: 'failed', data, error })
    })
    void session.document.then(
      (document) => { if (!reading.aborted) setLoad({ kind: 'loaded', data, document }) },
      (error: unknown) => { if (!reading.aborted) setLoad({ kind: 'failed', data, error }) },
    )
    return () => {
      lifetime.abort()
      void session.dispose()
    }
  }, [data, signal, attempt])
  if (data === undefined) return <p className={css.status} role="alert">{t('unsupported')}</p>
  if (load?.data !== data) return loading
  if (load.kind === 'failed') {
    return <div className={css.status} role="alert">
      <span>{failureText(load.error, t)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
    </div>
  }
  const pages = <section className={css.body} data-pdf-preview>
    {Array.from({ length: load.document.numPages }, (_, index) => (
      <PdfPage key={index} document={load.document} page={index + 1}
        requested={index === 0 || view.page === index + 1} onVisible={onPage} signal={signal}
        onWidth={index === 0 ? setPageWidth : undefined} zoom={renderZoom} zoomSurfaceClass={zoomSurfaceClass} t={t} />
    ))}
  </section>
  return <ZoomViewport preference={preference} intrinsicWidth={pageWidth} horizontalInset={24} labels={labels}
    signal={signal} scrollportRef={scrollportRef} onPreference={onZoom} onRenderZoom={setRenderZoom}>
    {pages}
  </ZoomViewport>
}

function PdfPage({ document, page, requested: initiallyRequested, onVisible, signal, onWidth, zoom, zoomSurfaceClass, t }: {
  readonly document: PdfDocument
  readonly page: number
  readonly requested: boolean
  readonly onVisible: (page: number) => void
  readonly signal: AbortSignal
  readonly onWidth: ((width: number) => void) | undefined
  readonly zoom: number
  readonly zoomSurfaceClass: string
} & PropsLocale<'sidebarPdf'>): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>()
  const [requested, setRequested] = useState(initiallyRequested)
  const [visible, setVisible] = useState(initiallyRequested)
  const renderedZoom = useRef<number>()
  const pendingRender = useRef(Promise.resolve())
  const textTask = useRef<ReturnType<ReturnType<typeof pdfTextRenderer>>>()
  const [state, setState] = useState<'loading' | 'ready'>('loading')
  const [failure, setFailure] = useState<{ readonly error: unknown }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    // A zoomed canvas can remain visible after its narrower page wrapper has
    // scrolled out horizontally. Observe the displayed page once it is ready.
    const node = state === 'ready' ? canvas.current as HTMLCanvasElement : host.current as HTMLDivElement
    if (typeof IntersectionObserver === 'undefined') {
      setRequested(true)
      setVisible(true)
      return
    }
    let disposed = false
    const observer = new IntersectionObserver((entries) => {
      if (disposed) return
      const intersects = entries.some(entry => entry.isIntersecting)
      setVisible(intersects)
      if (!intersects) return
      setRequested(true)
      onVisible(page)
    }, { rootMargin: '100% 0px' })
    observer.observe(node)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [page, onVisible, state])
  useEffect(() => () => { textTask.current?.cancel() }, [])
  useEffect(() => {
    if (!requested) return
    setFailure(undefined)
    if (renderedZoom.current !== undefined && (!visible || renderedZoom.current === zoom)) return
    const node = canvas.current as HTMLCanvasElement
    const lifetime = new AbortController()
    const renderSignal = AbortSignal.any([lifetime.signal, signal])
    let newText: typeof textTask.current
    // PDF.js shares a page proxy across renders; its cancelled task must finish
    // cleanup before another render starts. The displayed bitmap stays intact.
    pendingRender.current = pendingRender.current.then(async () => {
      renderSignal.throwIfAborted()
      const buffer = node.ownerDocument.createElement('canvas')
      try {
        const size = await renderPdfPage(document, page, buffer, renderSignal, window.devicePixelRatio * zoom,
          textTask.current === undefined ? (pdfPage, viewport) => {
            newText = pdfTextRenderer(text.current as HTMLDivElement)(pdfPage, viewport)
            return newText
          } : undefined)
        renderSignal.throwIfAborted()
        const context = node.getContext('2d')
        if (context === null) throw new Error('PDF canvas has no 2D context')
        node.width = buffer.width
        node.height = buffer.height
        node.style.setProperty('--pdf-page-width', `${size.width}px`)
        node.style.setProperty('--pdf-page-height', `${size.height}px`)
        context.drawImage(buffer, 0, 0)
        textTask.current ??= newText
        newText = undefined
        renderedZoom.current = zoom
        setWidth(size.width)
        onWidth?.(size.width)
        setState('ready')
      } finally {
        buffer.width = buffer.height = 0
        newText?.cancel()
      }
    }).catch((error: unknown) => { if (!renderSignal.aborted) setFailure({ error }) })
    return () => { lifetime.abort(); newText?.cancel() }
  }, [document, page, requested, visible, zoom, signal, attempt, onWidth])
  return <div ref={host} className={css.page} data-pdf-page={page}>
    {failure === undefined && state !== 'ready' && (requested
      ? <div className={css.placeholder} role="status" aria-label={t('rendering')} />
      : <div className={css.placeholder} />)}
    {failure !== undefined && <div className={css.status} role="alert">
      <span>{failureText(failure.error, t)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
    </div>}
    <div className={`${css.surface} ${zoomSurfaceClass}`} data-document-zoom-surface
      style={{ '--document-zoom-width': `${width ?? 0}px` } as CSSProperties}
      hidden={state !== 'ready'}>
      <canvas ref={canvas} className={css.canvas} role="img" aria-label={t('pageImage', { page })} />
      <div ref={text} className={css.text} data-pdf-text />
    </div>
  </div>
}

function failureText(error: unknown, t: PropsLocale<'sidebarPdf'>['t']): string {
  if (error instanceof PdfWorkerFailure) return t('workerFailed')
  if (error instanceof Error && error.name === 'PasswordException') return t('password')
  return t('failed', { message: error instanceof Error ? error.message : String(error) })
}
