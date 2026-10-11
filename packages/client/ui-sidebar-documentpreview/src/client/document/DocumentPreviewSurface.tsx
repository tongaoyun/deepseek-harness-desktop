/** Source loading and renderer choice for independently mounted byte previews. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Menu, IconWrapFillRegular, IconNowrapFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { PLAIN_BODY_ID } from '../text/index.ts'
import { binaryDocumentPath, matchingDocumentPreviews } from './registry.ts'
import { unviewableBinaryPath } from './unviewable.ts'
import type { DocumentContent } from './contract.ts'
import type { DocumentPreviewFile, DocumentPreviewSurfaceProps } from './surface-contract.ts'
import css from './DocumentPreviewSurface.module.css'

type Loaded = { readonly fileName: string; readonly read: DocumentPreviewSurfaceProps['read']; readonly renderOffice: DocumentPreviewSurfaceProps['renderOffice']; readonly revision: DocumentPreviewSurfaceProps['revision']; readonly attempt: number; readonly signal: AbortSignal } & (
  | { readonly file: DocumentPreviewFile }
  | { readonly error: unknown }
)

const ownsScrollport = (): void => {}

/** @param props - authorized source readers and framework renderer seats. @returns the original-file preview. */
export function DocumentPreviewSurface({
  fileName, read, renderOffice, revision, failureText, t, useDocumentPreviews, renderSlot,
}: DocumentPreviewSurfaceProps): ReactNode {
  const definitions = useDocumentPreviews(value => value)
  const candidates = useMemo(() => {
    const matching = matchingDocumentPreviews(definitions, fileName)
    if (binaryDocumentPath(definitions, fileName) || (matching.length === 0 && unviewableBinaryPath(fileName))) return matching
    const fallback = definitions.find(definition => definition.id === PLAIN_BODY_ID)
    return fallback === undefined ? matching : [...matching, fallback]
  }, [definitions, fileName])
  const [rendererId, setRendererId] = useState<string>()
  const selected = candidates.find(candidate => candidate.id === rendererId) ?? candidates[0]
  const [menuOpen, setMenuOpen] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded>()
  const office = /\.(?:docx?|pptx?)$/iu.test(fileName)
  useEffect(() => {
    if (selected === undefined) return
    const controller = new AbortController()
    const source = { fileName, read, renderOffice, revision, attempt, signal: controller.signal }
    setLoaded(undefined)
    void (async () => {
      try {
        const reader = office ? renderOffice : read
        if (reader === undefined) throw new Error('Office preview requires an authorized converter.')
        const file = await reader(controller.signal)
        if (!controller.signal.aborted) setLoaded({ ...source, file })
      } catch (error: unknown) {
        if (!controller.signal.aborted) setLoaded({ ...source, error })
      }
    })()
    return () => { controller.abort() }
  }, [fileName, read, renderOffice, revision, attempt, office, selected !== undefined])
  const current = loaded !== undefined && loaded.fileName === fileName && loaded.read === read
    && loaded.renderOffice === renderOffice && loaded.revision === revision && loaded.attempt === attempt
    ? loaded : undefined
  const content = useMemo((): DocumentContent | undefined => {
    if (current === undefined || !('file' in current) || selected === undefined) return undefined
    if (selected.loading !== 'text-pages') return { kind: 'bytes', data: current.file.data }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(current.file.data)
      if (text.includes('\0')) return undefined
      return { kind: 'text', text, pages: [{ offset: 1, text, lines: text === '' ? 0 : text.split('\n').length }], eof: true }
    } catch {
      // Invalid text never falls back to replacement characters or binary source rendering.
      return undefined
    }
  }, [current, selected])
  if (selected === undefined) return <div className={css.status} role="alert">{t('unsupportedFile')}</div>
  if (current === undefined) return <LoadingIndicator label={t('loading')} />
  if ('error' in current) return <div className={css.status} role="alert" data-document-preview-failed>
    <span>{failureText === undefined ? t('readFailed') : failureText(current.error)}</span>
    <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
  </div>
  if (content === undefined) return <div className={css.status} role="alert">{t('unsupportedFile')}</div>
  return <section className={css.surface} data-document-preview-surface data-document-preview={selected.id}>
    {(candidates.length > 1 || selected.wrap === true || (current.file.missingFonts?.length ?? 0) > 0) && <div className={css.toolbar}>
      {renderSlot('document.preview.fonts', { fonts: current.file.missingFonts ?? [] })}
      {candidates.length > 1 && <Menu open={menuOpen} anchor={
        <button type="button" className={css.tool} aria-label={t('openWith')} onClick={() => { setMenuOpen(value => !value) }}>{selected.title()}</button>
      } items={candidates.map(candidate => ({ id: candidate.id, label: candidate.title() }))} selectedId={selected.id}
      onSelect={(id) => { setRendererId(id); setMenuOpen(false) }} onClose={() => { setMenuOpen(false) }} align="end" />}
      {selected.wrap === true && <button type="button" className={css.tool} aria-label={t('wrap.aria')}
        title={t(wrap ? 'wrap.disable' : 'wrap.enable')} aria-pressed={wrap} onClick={() => { setWrap(value => !value) }}>
        {wrap ? <IconNowrapFillRegular size={16} /> : <IconWrapFillRegular size={16} />}
      </button>}
    </div>}
    <div className={clsx(css.body, wrap && css.wrap)} data-document-preview-surface-body>
      {renderSlot('document.preview.body', { fileName, content, signal: current.signal, wrap, scrollportRef: ownsScrollport }, {
        entryKey: selected.id, fallback: <div className={css.status} role="alert">{t('rendererUnavailable', { name: selected.title() })}</div>,
      })}
    </div>
  </section>
}
