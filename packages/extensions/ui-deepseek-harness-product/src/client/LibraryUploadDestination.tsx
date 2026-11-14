/** Choose an authorized destination before opening the existing native upload flow. */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryBrowser, type LibraryLocation, type LibraryText } from './LibraryBrowser.tsx'
import { LibraryUpload } from './LibraryUpload.tsx'
import css from '../DeepSeekHarnessProduct.module.css'
/** Reuse the same directory picker and upload receipts as in-library uploads.
 * @param props Native preview factory and completed-write callback.
 * @returns Destination chooser followed by the existing file upload dialog.
 */
export function LibraryUploadDestination(props: PropsRenderFactories & {
  readonly t: LibraryText
  readonly onClose: () => void
  readonly onCommitted: () => void
}): ReactNode {
  const [location, setLocation] = useState<LibraryLocation>()
  const [destination, setDestination] = useState<LibraryLocation>()
  const changeLocation = useCallback((value: LibraryLocation | undefined) => { setLocation(value) }, [])
  if (destination) return <LibraryUpload location={destination} t={props.t}
    onClose={props.onClose} onCommitted={props.onCommitted} />
  return <Modal open title={props.t('libraryUploadDestination')} closeLabel={props.t('close')}
    onClose={props.onClose} className={`${css.detailModal} ${css.libraryPicker}`}
    contentClassName={css.detailModalContent as string} footer={<div className={css.detailActions}>
      <Button variant="outline" onClick={props.onClose}>{props.t('cancel')}</Button>
      <Button variant="primary" aria-disabled={!location?.library.canManage} onClick={() => {
        if (location?.library.canManage) setDestination(location)
      }}>{props.t('libraryChoose')}</Button>
    </div>}>
    <LibraryBrowser t={props.t} renderFactorySlot={props.renderFactorySlot} foldersOnly onLocation={changeLocation} />
  </Modal>
}
