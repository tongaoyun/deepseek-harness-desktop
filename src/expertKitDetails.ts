import { normalizePermissions, type ExpertKitView } from './expertKits'
import type { ExpertKitPermissions, PermissionMode } from './types'

export interface PermissionDetail {
  key: keyof ExpertKitPermissions
  label: string
  description: string
  mode: PermissionMode
}

const permissionDefinitions: Array<Omit<PermissionDetail, 'mode'>> = [
  { key: 'localFiles', label: '本地文件与 Office', description: '读取或写入已由员工授权的文件目录' },
  { key: 'shell', label: 'Shell 命令', description: '在员工电脑的受控运行环境中执行命令' },
  { key: 'connectorRead', label: '企业数据读取', description: '通过连接器查询 ERP 等公司系统' },
  { key: 'connectorWrite', label: '企业数据写入', description: '通过连接器修改公司系统中的业务数据' },
]

export function expertKitPermissionDetails(kit: ExpertKitView): PermissionDetail[] {
  const permissions = normalizePermissions(kit.permissions)
  return permissionDefinitions.map((definition) => ({ ...definition, mode: permissions[definition.key] }))
}

export function permissionModeLabel(mode: PermissionMode): string {
  return ({ deny: '不允许', allow: '直接允许', approval: '每次确认' })[mode]
}

export function expertKitChanges(kit: ExpertKitView): string[] {
  if (kit.installState !== 'update' || !kit.installed) return []
  const installed = kit.installed.manifest
  const changes = [
    ...setChanges('命令', installed.commands.map((entry) => entry.id), kit.commandIds),
    ...setChanges('技能', installed.skills.map((entry) => entry.id), kit.skillIds),
    ...setChanges('连接器', installed.connectorRefs, kit.connectorRefs),
    ...setChanges('知识库', installed.knowledgeBaseRefs ?? [], kit.knowledgeBaseRefs),
    ...setChanges('后台工作流', installed.serverWorkflows.map((entry) => entry.id), kit.serverWorkflows.map((entry) => entry.id)),
  ]
  const before = normalizePermissions(installed.permissions)
  const after = normalizePermissions(kit.permissions)
  for (const definition of permissionDefinitions) {
    if (before[definition.key] !== after[definition.key]) {
      changes.push(`${definition.label}：${permissionModeLabel(before[definition.key])} → ${permissionModeLabel(after[definition.key])}`)
    }
  }
  return changes.length > 0 ? changes : ['能力声明没有变化，本次仅更新套件内容。']
}

export function expertKitHasPermissionExpansion(kit: ExpertKitView): boolean {
  if (kit.installState !== 'update' || !kit.installed) return false
  const rank: Record<PermissionMode, number> = { deny: 0, approval: 1, allow: 2 }
  const before = normalizePermissions(kit.installed.manifest.permissions)
  const after = normalizePermissions(kit.permissions)
  return permissionDefinitions.some(({ key }) => rank[after[key]] > rank[before[key]])
}

function setChanges(label: string, before: string[], after: string[]): string[] {
  const previous = new Set(before)
  const next = new Set(after)
  const added = after.filter((value) => !previous.has(value))
  const removed = before.filter((value) => !next.has(value))
  return [
    ...(added.length > 0 ? [`新增${label}：${added.join('、')}`] : []),
    ...(removed.length > 0 ? [`移除${label}：${removed.join('、')}`] : []),
  ]
}
