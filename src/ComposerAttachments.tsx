import { FileText, Image, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { loadLocalArtifactPreview, type LocalArtifactTarget } from './localArtifactPreview'
import type { LocalTaskAttachment } from './types'

export function ComposerAttachments({ attachments, disabled, onOpen, onRemove }: {
  attachments: LocalTaskAttachment[]; disabled?: boolean; onOpen: (target: LocalArtifactTarget) => void; onRemove: (id: string) => void
}) {
  return attachments.length ? <div aria-label="任务附件" className="composer-attachments">{attachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} disabled={disabled} onOpen={onOpen} onRemove={onRemove} />)}</div> : null
}
function Attachment({ attachment, disabled, onOpen, onRemove }: {
  attachment: LocalTaskAttachment; disabled?: boolean; onOpen: (target: LocalArtifactTarget) => void; onRemove: (id: string) => void
}) {
  const [image, setImage] = useState('')
  useEffect(() => {
    if (attachment.kind !== 'image') return
    let disposed = false
    void loadLocalArtifactPreview(attachment).then((preview) => { if (!disposed) setImage(preview.dataUrl ?? '') }).catch(() => {})
    return () => { disposed = true }
  }, [attachment])
  return <div className={`composer-attachment ${attachment.kind}`}>
    <button aria-label={`预览附件 ${attachment.name}`} className="composer-attachment-open" onClick={() => onOpen(attachment)} title={attachment.name} type="button">
      {image ? <img alt="" src={image} /> : attachment.kind === 'image' ? <Image size={22} /> : <FileText size={22} />}
      <span>{attachment.name}<small>{attachment.kind === 'image' ? '图片' : attachment.name.split('.').at(-1)?.toUpperCase() || '文件'}</small></span>
    </button><button aria-label={`移除附件 ${attachment.name}`} className="composer-attachment-remove" disabled={disabled} onClick={() => onRemove(attachment.id)} type="button"><X size={12} /></button>
  </div>
}
