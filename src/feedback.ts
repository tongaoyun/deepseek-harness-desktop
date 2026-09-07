import { invoke } from '@tauri-apps/api/core'
export type FeedbackCategory = 'BUG' | 'SUGGESTION' | 'QUESTION' | 'OTHER'
export type FeedbackSubmit = (message: string, category: FeedbackCategory, images?: File[]) => Promise<void>
export function validateFeedbackImages(files: File[], count: number): string {
  if (files.length + count > 4) return '最多添加 4 张图片'
  if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return '请选择 PNG、JPEG 或 WebP 图片'
  if (files.some((file) => !file.size || file.size > 5 * 1024 * 1024)) return '图片不能为空，单张不能超过 5 MB'
  if (files.some((file) => file.name.length > 255)) return '图片文件名过长，请重命名后再添加'
  return ''
}
export async function readFeedbackPaths(paths: string[]): Promise<File[]> {
  if (paths.length > 4) throw new Error('最多添加 4 张图片')
  return Promise.all(paths.map(async (path) => {
    const image = await invoke<{ name: string; mediaType: string; data: string }>('read_feedback_image', { path })
    const bytes = Uint8Array.from(atob(image.data), (value) => value.charCodeAt(0))
    return new File([bytes], image.name, { type: image.mediaType })
  }))
}
