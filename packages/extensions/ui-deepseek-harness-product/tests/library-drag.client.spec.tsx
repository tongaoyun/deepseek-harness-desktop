// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Library, LibraryEntry } from '@deepseek-harness/product/library'
import { useLibraryDrag } from '../src/client/useLibraryDrag.ts'

const request = vi.fn()
vi.mock('../src/client/library-data.ts', () => ({ useLibraryRequests: () => request }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const library: Library = { id: 'personal', name: '我的资料', scope: 'PERSONAL', ownerId: 'owner', companyId: 'company',
  role: 'OWNER', canManage: true, version: 1, createdAt: '', updatedAt: '' }
const folder: LibraryEntry = { id: 'folder', libraryId: library.id, parentId: null, name: '项目', kind: 'FOLDER',
  sha256: null, mediaType: null, sizeBytes: 0, version: 1, createdAt: '', updatedAt: '' }
function fixture() {
  const success = vi.fn(), failure = vi.fn(), finish = vi.fn()
  function Surface() {
    const drag = useLibraryDrag({ isBusy: () => false, onStart: () => {},
      onSuccess: success, onFailure: failure, onFinish: finish })
    return <div {...drag({ library, parentId: 'outer' })}>
      <button {...drag({ library, parentId: folder.id }, { entry: folder, libraryName: library.name,
        canManage: true, lastAccessedAt: null })}>source</button>
      <button {...drag({ library, parentId: 'child' }, undefined, [folder.id, 'child'])}>descendant</button>
      <button {...drag({ library, parentId: null })}>original</button>
      <button {...drag({ library: { ...library, canManage: false }, parentId: 'readonly' })}>readonly</button>
      <button {...drag({ library: { ...library, id: 'other' }, parentId: null })}>other</button>
      <button {...drag({ library, parentId: 'destination' })}>destination</button>
      <div role="group" aria-label="nested destination" {...drag({ library, parentId: 'destination' })}>
        <button {...drag(undefined, { entry: folder, libraryName: library.name, canManage: true, lastAccessedAt: null })}>
          nested source</button>
        <span>metadata</span>
      </div>
    </div>
  }
  const rendered = render(<Surface />)
  return { ...rendered, success, failure, finish, transfer: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } }
}
it('blocks folder self, descendant, same-location, readonly and cross-library drops without falling through to the outer directory', () => {
  const f = fixture(), source = screen.getByRole('button', { name: 'source' })
  expect(source.draggable).toBe(true)
  for (const name of ['source', 'descendant', 'original', 'readonly', 'other']) {
    const target = screen.getByRole('button', { name })
    fireEvent.dragStart(source, { dataTransfer: f.transfer })
    fireEvent.dragOver(target, { dataTransfer: f.transfer })
    expect(f.transfer.dropEffect).toBe('none')
    expect(target.hasAttribute('data-library-drop-target')).toBe(false)
    fireEvent.drop(target, { dataTransfer: f.transfer })
  }
  expect(request).not.toHaveBeenCalled()
})
it('moves a folder once and cancels a late result when the page unmounts', async () => {
  const f = fixture(), move = Promise.withResolvers<unknown>()
  request.mockReturnValue(move.promise)
  const source = screen.getByRole('button', { name: 'source' }), target = screen.getByRole('button', { name: 'destination' })
  fireEvent.dragStart(source, { dataTransfer: f.transfer })
  fireEvent.dragOver(target, { dataTransfer: f.transfer })
  expect(target.getAttribute('data-library-drop-target')).toBe('true')
  fireEvent.drop(target, { dataTransfer: f.transfer })
  fireEvent.dragStart(source, { dataTransfer: f.transfer }); fireEvent.drop(target, { dataTransfer: f.transfer })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[1]).toEqual({ libraryId: library.id, entryId: folder.id, name: folder.name, parentId: 'destination', version: 1 })
  const signal = request.mock.calls[0]?.[2] as AbortSignal
  f.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { move.resolve(folder) })
  expect(f.success).not.toHaveBeenCalled()
  expect(f.failure).not.toHaveBeenCalled()
  expect(f.finish).not.toHaveBeenCalled()
})

it('retains the directory highlight while dragging from its file name to metadata in the same row', () => {
  const f = fixture(), source = screen.getByRole('button', { name: 'source' })
  const target = screen.getByRole('group', { name: 'nested destination' })
  const name = screen.getByRole('button', { name: 'nested source' }), metadata = screen.getByText('metadata')
  fireEvent.dragStart(source, { dataTransfer: f.transfer })
  fireEvent.dragOver(name, { dataTransfer: f.transfer })
  expect(target.getAttribute('data-library-drop-target')).toBe('true')
  fireEvent(name, new MouseEvent('dragleave', { bubbles: true, relatedTarget: metadata }))
  expect(target.getAttribute('data-library-drop-target')).toBe('true')
  expect(screen.getByRole('group', { name: 'nested destination' })).toBe(target)
  fireEvent(target, new MouseEvent('dragleave', { bubbles: true, relatedTarget: document.body }))
  expect(target.hasAttribute('data-library-drop-target')).toBe(false)
  expect(request).not.toHaveBeenCalled()
})
it('does not clear a new directory highlight when a previous directory reports leaving', () => {
  const f = fixture(), source = screen.getByRole('button', { name: 'source' })
  const previous = screen.getByRole('button', { name: 'destination' })
  const target = screen.getByRole('group', { name: 'nested destination' })
  fireEvent.dragStart(source, { dataTransfer: f.transfer })
  fireEvent.dragOver(previous, { dataTransfer: f.transfer })
  fireEvent.dragOver(target.parentElement!, { dataTransfer: f.transfer })
  expect(target.parentElement!.getAttribute('data-library-drop-target')).toBe('true')
  fireEvent(previous, new MouseEvent('dragleave', { bubbles: true, relatedTarget: target.parentElement }))
  expect(target.parentElement!.getAttribute('data-library-drop-target')).toBe('true')
  fireEvent.dragEnd(source)
  expect(target.parentElement!.hasAttribute('data-library-drop-target')).toBe(false)
})
