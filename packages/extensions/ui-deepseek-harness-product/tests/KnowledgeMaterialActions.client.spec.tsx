// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeAddMenu, KnowledgeDocumentActions, KnowledgeFolderActions } from '../src/client/KnowledgeMaterialActions.tsx'
import { zh } from '../src/locales.ts'

const t = (key: keyof typeof zh) => zh[key]
const document = { id: 'doc', knowledgeBaseId: 'base', filename: '资料.md', mediaType: 'text/markdown', sizeBytes: 12, chunkCount: 1, status: 'READY', updatedAt: '2026-11-08T00:00:00Z' }
const folder = { id: 'folder', name: '参考资料', parentId: null, updatedAt: document.updatedAt }
afterEach(cleanup)

it.each((['add', 'document', 'folder'] as const).flatMap(kind => (['disabled', 'pending'] as const).map(reason => ({ kind, reason }))))('closes the $kind menu while $reason and requires reopening', ({ kind, reason }) => {
  const onSelect = vi.fn(), onUpload = vi.fn()
  const menu = (blocked: boolean) => {
    const disabled = blocked && reason === 'disabled', pending = blocked && reason === 'pending'
    return kind === 'add'
      ? <KnowledgeAddMenu disabled={disabled} pending={pending} uploadDisabled={false} onSelect={onSelect} onUpload={onUpload} t={t} />
      : kind === 'document'
        ? <KnowledgeDocumentActions document={document} disabled={disabled} pending={pending}
          canManage canOpenExternal={false} onSelect={onSelect} t={t} />
        : <KnowledgeFolderActions folder={folder} disabled={disabled} pending={pending} onSelect={onSelect} t={t} />
  }
  const view = render(menu(false))
  const trigger = screen.getByRole('button')
  trigger.focus()
  fireEvent.click(trigger)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.rerender(menu(true))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.hasAttribute('disabled')).toBe(reason === 'disabled')
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  expect(trigger.classList.contains('product-control-pending')).toBe(reason === 'pending')
  if (reason === 'pending') expect(globalThis.document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
  expect(onUpload).not.toHaveBeenCalled()
  view.rerender(menu(false))
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  const label = kind === 'add' ? zh.knowledgeNewDocument : kind === 'document' ? zh.knowledgeReadDocument : zh.knowledgeRenameFolder
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(kind === 'add' ? 'markdown' : kind === 'document' ? 'read' : 'rename')
  expect(onUpload).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
})
