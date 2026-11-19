import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import type { LibraryLocation } from './LibraryBrowser.tsx'
import type { LibraryItem } from './LibraryFileList.tsx'
import { useLibraryRequests } from './library-data.ts'

/** Native HTML drag handlers for authorized file sources and directory targets. */
export type LibraryDragProps = (
  location?: LibraryLocation, file?: LibraryItem, ancestors?: readonly string[],
) => HTMLAttributes<HTMLElement> & {
  readonly 'data-library-drop-target'?: true | undefined
}
const TRANSFER_TYPE = 'application/x-dsh-library-entry'

/** Move a file or folder within its library using the existing versioned metadata operation.
 * @param options Page-owned write lock, result feedback and refresh callbacks.
 * @returns Drag handlers shared by native tree rows and the file list.
 */
export function useLibraryDrag(options: {
  readonly isBusy: () => boolean
  readonly onStart: (file: LibraryItem) => void
  readonly onSuccess: () => void
  readonly onFailure: (error: unknown) => void
  readonly onFinish: () => void
}): LibraryDragProps {
  const request = useLibraryRequests()
  const source = useRef<LibraryItem>()
  const active = useRef<AbortController>()
  const [moving, setMoving] = useState<string>()
  const [target, setTarget] = useState<string>()
  useEffect(() => () => { active.current?.abort(); source.current = undefined }, [])
  return (location, file, ancestors = []) => {
    const key = location && `${location.library.id}/${location.parentId ?? ''}`
    const allowed = () => source.current && !active.current && !options.isBusy() && location?.library.canManage
      && source.current.entry.libraryId === location.library.id && source.current.entry.parentId !== location.parentId
      && source.current.entry.id !== location.parentId && !ancestors.includes(source.current.entry.id)
    return {
      draggable: file?.canManage === true,
      'aria-busy': file !== undefined && file.entry.id === moving || undefined,
      'data-library-drop-target': key !== undefined && key === target ? true : undefined,
      onDragStart: (event) => {
        if (!file?.canManage || options.isBusy() || active.current) { event.preventDefault(); return }
        source.current = file
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(TRANSFER_TYPE, file.entry.id)
        event.stopPropagation()
      },
      onDragEnd: () => { source.current = undefined; setTarget(undefined) },
      onDragOver: (event) => {
        if (!source.current || !location) return
        event.preventDefault(); event.stopPropagation()
        if (!allowed()) { event.dataTransfer.dropEffect = 'none'; setTarget(undefined); return }
        event.dataTransfer.dropEffect = 'move'
        setTarget(key)
      },
      onDragLeave: (event) => {
        if (key !== undefined && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)))
          setTarget(current => current === key ? undefined : current)
      },
      onDrop: (event) => {
        if (!location || !source.current) return
        event.preventDefault(); event.stopPropagation()
        if (!allowed()) { source.current = undefined; setTarget(undefined); return }
        const moved = source.current
        source.current = undefined; setTarget(undefined)
        const controller = new AbortController()
        active.current = controller
        setMoving(moved.entry.id)
        options.onStart(moved)
        void request('library.entries.update', {
          libraryId: moved.entry.libraryId, entryId: moved.entry.id, name: moved.entry.name,
          parentId: location.parentId, version: moved.entry.version,
        }, controller.signal).then(() => {
          controller.signal.throwIfAborted()
          options.onSuccess()
        }).catch((error: unknown) => {
          if (!controller.signal.aborted) options.onFailure(error)
        }).finally(() => {
          if (active.current === controller) active.current = undefined
          if (!controller.signal.aborted) { setMoving(undefined); options.onFinish() }
        })
      },
    }
  }
}
