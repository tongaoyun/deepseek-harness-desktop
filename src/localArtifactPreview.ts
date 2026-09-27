import { invoke, isTauri } from '@tauri-apps/api/core'
import type { TaskFileChange } from './types'

export interface UndoFileResult { id: string; undoneAt: string; recoveryPath: string }

export function undoUnavailableReason(change: TaskFileChange): string {
  if (change.undoneAt) return '已撤销'
  if (change.action === 'deleted' || change.action === 'moved') return '移动和删除请通过备份手动恢复'
  if (!change.afterHash || (change.backupPath && !change.beforeHash) || (change.action === 'updated' && !change.backupPath)) return '缺少可验证的改动记录，不能自动撤销'
  return ''
}

export async function undoLocalFileChange(change: TaskFileChange): Promise<UndoFileResult> {
  if (!isTauri()) throw new Error('文件撤销仅在小胤桌面端可用')
  const reason = undoUnavailableReason(change)
  if (reason) throw new Error(reason)
  const recoveryPath = await invoke<string>('undo_local_file_change', {
    request: {
      rootId: change.rootId, path: change.path, action: change.action,
      afterHash: change.afterHash, beforeHash: change.beforeHash ?? null, backupPath: change.backupPath ?? null,
    },
  })
  return { id: change.id, undoneAt: new Date().toISOString(), recoveryPath }
}

export interface LocalArtifactTarget {
  rootId: string
  rootName: string
  path: string
  name: string
  initialView?: 'preview' | 'review'
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
  kind: 'code' | 'text' | 'markdown' | 'image' | 'pdf' | 'audio' | 'video' | 'file'
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

export function htmlArtifactPreviewUrl(target: LocalArtifactTarget): Promise<string> {
  return invoke<string>('html_artifact_preview_url', { rootId: target.rootId, path: target.path })
}

export async function revealLocalArtifact(target: LocalArtifactTarget): Promise<void> {
  if (!isTauri()) throw new Error('文件定位仅在小胤桌面端可用')
  await invoke('reveal_local_artifact', { rootId: target.rootId, path: target.path })
}

export async function openLocalArtifact(target: LocalArtifactTarget): Promise<void> {
  if (!isTauri()) throw new Error('打开原文件仅在小胤桌面端可用')
  await invoke('open_local_artifact', { rootId: target.rootId, path: target.path })
}

export function artifactFailure(message: string): { kind: 'authorization' | 'missing' | 'permission' | 'other'; title: string; hint: string } {
  if (/XY-FILE-AUTH|授权已失效/.test(message)) return { kind: 'authorization', title: '需要重新授权目录', hint: '请选择原工作目录后重试。目录授权失效不代表文件已删除。' }
  if (/XY-FILE-MISSING|不存在或已被移动|No such file/i.test(message)) return { kind: 'missing', title: '原路径找不到文件', hint: '文件可能被移动或删除。可选择你找到的文件打开；不会自动重新生成或覆盖原文件。' }
  if (/XY-FILE-PERMISSION|Permission denied|权限|Operation not permitted/i.test(message)) return { kind: 'permission', title: '暂时没有文件访问权限', hint: '请检查系统文件访问权限后重试，也可通过文件选择器重新选择。' }
  return { kind: 'other', title: '无法打开文件', hint: '请重试读取，或选择本地文件打开。' }
}

export async function loadHarnessImagePreview(employeeId: string, attachmentId: string, mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'): Promise<string> {
  if (!isTauri()) throw new Error('截图预览仅在小胤桌面端可用')
  return invoke<string>('read_harness_image_preview', { employeeId, attachmentId, mediaType })
}
