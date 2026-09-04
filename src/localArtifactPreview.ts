import { invoke, isTauri } from '@tauri-apps/api/core'

export interface LocalArtifactTarget {
  rootId: string
  rootName: string
  path: string
  name: string
  review?: {
    action: 'created' | 'updated' | 'copied' | 'moved' | 'deleted'
    backupPath?: string
    addedLines?: number
    deletedLines?: number
  }
}

export interface LocalArtifactPreview {
  name: string
  path: string
  kind: 'code' | 'text' | 'image' | 'pdf' | 'office' | 'file'
  language?: string
  content?: string
  dataUrl?: string
  sizeBytes: number
  truncated: boolean
}

export async function loadLocalArtifactPreview(target: LocalArtifactTarget): Promise<LocalArtifactPreview> {
  if (!isTauri()) throw new Error('文件预览仅在小胤桌面端可用')
  return invoke<LocalArtifactPreview>('read_local_artifact_preview', {
    rootId: target.rootId,
    path: target.path,
  })
}

export async function revealLocalArtifact(target: LocalArtifactTarget): Promise<void> {
  if (!isTauri()) throw new Error('文件定位仅在小胤桌面端可用')
  await invoke('reveal_local_artifact', { rootId: target.rootId, path: target.path })
}

export async function loadHarnessImagePreview(attachmentId: string, mediaType: 'image/png' | 'image/jpeg'): Promise<string> {
  if (!isTauri()) throw new Error('截图预览仅在小胤桌面端可用')
  return invoke<string>('read_harness_image_preview', { attachmentId, mediaType })
}
