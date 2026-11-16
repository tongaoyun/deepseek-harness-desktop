/** Create folders or upload to the current directory; otherwise choose a destination. */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryBrowser, type LibraryLocation, type LibraryText } from './LibraryBrowser.tsx'
import { LibraryMutation } from './LibraryMutation.tsx'
import { LibraryUpload } from './LibraryUpload.tsx'
import css from '../DeepSeekHarnessProduct.module.css'
/** Reuse the directory picker and existing mutation dialogs.
 * @param props Operation, native preview factory and completed-write callback.
 * @returns Folder form, current-directory upload or upload destination chooser.
 */
export function LibraryDestination(props: PropsRenderFactories & {
  readonly kind: 'upload' | 'folder'
  readonly t: LibraryText
  readonly initialLocation?: LibraryLocation
  readonly onClose: () => void
  readonly onCommitted: (location?: LibraryLocation) => void
}): ReactNode {
  const [location, setLocation] = useState<LibraryLocation>()
  const [destination, setDestination] = useState<LibraryLocation | undefined>(props.initialLocation)
  const changeLocation = useCallback((value: LibraryLocation | undefined) => { setLocation(value) }, [])
  if (props.kind === 'folder') return <LibraryMutation kind="folder" t={props.t}
    {...(props.initialLocation ? { location: props.initialLocation } : {})} onClose={props.onClose} onCommitted={props.onCommitted} />
  if (destination) return <LibraryUpload location={destination} t={props.t} onClose={props.onClose} onCommitted={props.onCommitted} />
  return <Modal open title={props.t('libraryUploadDestination')} closeLabel={props.t('close')}
    onClose={props.onClose} className={`${css.detailModal} ${css.libraryPicker}`}
    contentClassName={css.detailModalContent as string} footer={<div className={css.libraryPickerActions}>
      <Button variant="outline" onClick={props.onClose}>{props.t('cancel')}</Button>
      <Button variant="primary" aria-disabled={!location?.library.canManage} onClick={() => {
        if (location?.library.canManage) setDestination(location)
      }}>{props.t('libraryChoose')}</Button>
    </div>}>
    <LibraryBrowser t={props.t} renderFactorySlot={props.renderFactorySlot} foldersOnly onLocation={changeLocation} />
  </Modal>
}
