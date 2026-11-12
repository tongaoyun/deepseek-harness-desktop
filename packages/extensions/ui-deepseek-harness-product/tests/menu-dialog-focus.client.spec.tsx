// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { KnowledgeAddMenu, KnowledgeDocumentActions, KnowledgeFolderActions } from '../src/client/KnowledgeMaterialActions.tsx'
import { KnowledgeLibraryActions } from '../src/client/KnowledgeLibraryActions.tsx'
import { ResourceActionsMenu } from '../src/client/ResourceActionsMenu.tsx'
import { zh } from '../src/locales.ts'

const t = (key: keyof typeof zh) => zh[key]
const material = { id: 'doc', knowledgeBaseId: 'base', filename: '资料.md', mediaType: 'text/markdown',
  sizeBytes: 12, chunkCount: 1, sourceType: 'manual', status: 'READY', updatedAt: '2026-11-09T00:00:00Z' }
const folder = { id: 'folder', name: '参考资料', parentId: null, updatedAt: material.updatedAt }
const cases = [
  { kind: 'add', label: zh.knowledgeNewDocument },
  { kind: 'document', label: zh.modifyResource },
  { kind: 'folder', label: zh.knowledgeRenameFolder },
  { kind: 'library', label: zh.knowledgeEditBase },
  { kind: 'connector', label: zh.submitShared },
] as const

function DialogFlow({ kind }: { readonly kind: typeof cases[number]['kind'] }) {
  const [open, setOpen] = useState(false)
  const show = () => { setOpen(true) }
  const menu = kind === 'add' ? <KnowledgeAddMenu disabled={false} uploadDisabled={false} onUpload={vi.fn()} onSelect={show} t={t} />
    : kind === 'document' ? <KnowledgeDocumentActions document={material} disabled={false} canManage canOpenExternal={false} onSelect={show} t={t} />
      : kind === 'folder' ? <KnowledgeFolderActions folder={folder} disabled={false} onSelect={show} t={t} />
        : kind === 'library' ? <KnowledgeLibraryActions name="项目资料" disabled={false} onEdit={show} t={t} />
          : <ResourceActionsMenu resource={{ canEdit: true, canSubmit: true, canDelete: true, version: '1.0.0' }}
            onEdit={show} onSubmit={show} onDelete={show} t={t} />
  return <>{menu}<Modal open={open} title={zh.modifyResource} closeLabel={zh.close} onClose={() => { setOpen(false) }}>
    <input aria-label={zh.knowledgeBaseName} defaultValue="项目资料" />
  </Modal></>
}

afterEach(cleanup)

it.each(cases)('returns keyboard focus to the $kind trigger after dismissing its dialog', async ({ kind, label }) => {
  render(<DialogFlow kind={kind} />)
  const trigger = screen.getByRole('button')
  trigger.focus()
  fireEvent.click(trigger)
  const item = screen.getByRole('menuitem', { name: label })
  item.focus()
  fireEvent.click(item)
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => { expect(dialog.contains(document.activeElement)).toBe(true) })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(document.activeElement).toBe(trigger)
})
