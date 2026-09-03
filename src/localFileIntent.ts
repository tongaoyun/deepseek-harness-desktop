const LOCAL_LOCATION = /(?:下载(?:目录|文件夹)?|Downloads?|桌面|Desktop|本地(?:文件|目录|文件夹)|电脑(?:里|上|中的?)|文件夹|目录(?:里|中|下))/i
const FILE_ACTION = /(?:看(?:下|看)?|查看|列出|读取|打开|查找|搜索|整理|分析|扫描|修改|写入|创建|新建|生成|保存|导出|删除|复制|移动|重命名|有(?:什么|啥))/i
const EXPLICIT_PATH = /(?:^|\s)(?:~[\\/]|\/(?:Users|home|tmp|Volumes)\/|[A-Za-z]:[\\/])/i
const FILE_OUTPUT = /(?:生成|保存|导出|创建|新建).{0,16}(?:文件|文档|表格|PDF|Excel|Word|PPT)/i

/** Returns true when a task cannot proceed without a user-approved local directory. */
export function needsLocalDirectoryAuthorization(input: string): boolean {
  const normalized = input.trim()
  if (!normalized) return false
  return EXPLICIT_PATH.test(normalized)
    || (LOCAL_LOCATION.test(normalized) && FILE_ACTION.test(normalized))
    || FILE_OUTPUT.test(normalized)
}
