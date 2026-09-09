export type StandardLocalDirectory = 'downloads' | 'desktop' | 'documents'

/** A named system directory in the prompt is itself an explicit task scope. */
export function standardLocalDirectories(input: string): StandardLocalDirectory[] {
  const directories: StandardLocalDirectory[] = []
  if (/(?:下载(?:目录|文件夹)|\bDownloads\b)/i.test(input)) directories.push('downloads')
  if (/(?:桌面(?!应用|客户端|助手)|\bDesktop\b)/i.test(input)) directories.push('desktop')
  if (/(?:文档(?:目录|文件夹)|\bDocuments\b)/i.test(input)) directories.push('documents')
  return directories
}
