/** Reversible reusable preview assembly independent of Session and Sidebar ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../../config.ts'
import { DocumentPreviewSurface } from './DocumentPreviewSurface.tsx'
import { SurfaceCode, SurfaceExcel, SurfaceHtml, SurfaceImage, SurfaceMarkdown, SurfacePdf, SurfaceText } from './surface-bodies.tsx'
import { PDF_BODY_ID } from '../pdf/index.ts'
import { IMAGE_BODY_ID } from '../image/index.ts'
import { PLAIN_BODY_ID } from '../text/index.ts'
import { FontNotice } from '../office/FontNotice.tsx'
import type {} from './surface-contract.ts'

/**
 * Register the reusable document Factory and its native bodies.
 * @param ctx - the registries and locale owned by the preview plugin.
 * @param config - resolved preview limits.
 */
export function applyDocumentSurface(ctx: Context, config: Config): void {
  const previews = ctx.documentPreviews
  ctx.effect(() => ctx.slots.registerFactory({
    name: 'document.preview', scope: 'root', locale: 'sidebarDocumentPreview',
    children: {
      'document.preview.body': { kind: 'keyed', scope: 'root' },
      'document.preview.fonts': { kind: 'list', scope: 'root' },
    },
    inject: () => ({ hooks: { documentPreviews: { getSnapshot: previews.getSnapshot, subscribe: previews.subscribe } } }),
  }, DocumentPreviewSurface))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.fonts', id: 'missing-fonts', locale: 'sidebarOffice' }, FontNotice))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: PDF_BODY_ID, locale: 'sidebarPdf' }, SurfacePdf))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office', locale: 'sidebarPdf' }, SurfacePdf))
  ctx.effect(() => ctx.slots.register({
    name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel', locale: 'sidebarExcel',
    inject: () => ({ limits: config.excel }),
  }, SurfaceExcel))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: IMAGE_BODY_ID, locale: 'sidebarImage' }, SurfaceImage))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: PLAIN_BODY_ID }, SurfaceText))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown', locale: 'documentMarkdown' }, SurfaceMarkdown))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/html', locale: 'documentHtml' }, SurfaceHtml))
  ctx.effect(() => ctx.slots.register({ name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code', locale: 'sidebarCodePreview' }, SurfaceCode))
}
