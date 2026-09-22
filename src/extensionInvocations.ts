import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { splitComposerPrompt } from './composerInput'
import type { CapabilitySelection } from './types'

export interface ExtensionInvocation {
  token: string
  name: string
  description: string
  kind: 'expert-kit' | 'skill'
  id: string
  selection: CapabilitySelection
}

// Command ids are stable runtime keys, not user-facing labels. Keep the labels here so the
// slash picker never exposes package filenames when a package has not published display metadata.
const COMMAND_LABELS: Record<string, string> = {
  access: '无障碍检查',
  'api-design': 'API 接口设计',
  audit: '启发评估',
  avatar: '数字人头像',
  bench: '竞品拆解',
  board: '视觉情绪板',
  brief: '设计简报',
  chart: '数据可视化',
  check: '设计走查',
  'code-review': '代码审查',
  'database-design': '数据库设计',
  edge: '异常态',
  extract: '设计提取',
  'flow-mobile': '移动页面设计',
  'flow-web': 'Web 流程',
  frame: '问题框定',
  'java-business-development': 'Java 业务开发',
  journey: '用户旅程',
  metric: '设计度量',
  'motion-apply': '动效落地',
  'motion-plan': '动效规划',
  'order-amount-explain': '订单金额',
  'order-intake-check': '订单排查',
  'performance-tuning': '性能调优',
  pitch: '设计提案',
  poster: '营销海报',
  prd: '写 PRD',
  probe: '用户研究',
  qa: '设计验收',
  retro: '设计复盘',
  refactoring: '重构建议',
  scope: '读需求',
  signal: '工单分析',
  sitemap: '站点地图',
  stories: '用户故事',
  test: '可用性测试',
  'unit-testing': '单元测试',
  'vue-component-development': 'Vue 组件开发',
}

export function extensionCommandLabel(id: string, index = 0): string {
  return COMMAND_LABELS[id] ?? `快捷命令 ${index + 1}`
}

export function extensionCommandSlashLabel(id: string, index = 0): string {
  const label = extensionCommandLabel(id, index)
  return label.startsWith('快捷命令 ') ? id : label
}

export function extensionInvocations(kits: ExpertKitView[], skills: SkillView[]): ExtensionInvocation[] {
  return [
    ...skills.filter((skill) => skill.installed?.enabled !== false && skill.installState === 'installed').map((skill): ExtensionInvocation => ({
      token: `/skill:${skill.id}`, name: skill.name, description: skill.summary, kind: 'skill', id: skill.id,
      selection: { mode: 'explicit', kind: 'skill', extensionId: skill.id, extensionVersion: skill.installedVersion ?? skill.version, skillId: skill.id },
    })),
    ...kits.filter((kit) => kit.installed?.enabled !== false && kit.installState === 'installed').flatMap((kit): ExtensionInvocation[] => {
      const version = kit.installed?.manifest.version ?? kit.version
      const commands = kit.installed?.manifest.commands ?? []
      return [
        { token: `/kit:${kit.id}`, name: kit.name, description: kit.summary, kind: 'expert-kit', id: kit.id,
          selection: { mode: 'explicit', kind: 'expert-kit', extensionId: kit.id, extensionVersion: version } },
        ...commands.map((command, index): ExtensionInvocation => ({
          token: `/kit:${kit.id}:${command.id}`, name: `${kit.name} · ${extensionCommandLabel(command.id, index)}`, description: '执行套件快捷命令', kind: 'expert-kit', id: kit.id,
          selection: { mode: 'explicit', kind: 'expert-kit', extensionId: kit.id, extensionVersion: version, commandId: command.id, ...(command.skillId ? { skillId: command.skillId } : {}) },
        })),
      ]
    }),
  ]
}

export function sameCapabilitySelection(left: CapabilitySelection, right: CapabilitySelection): boolean {
  return left.mode === right.mode && left.kind === right.kind
    && left.extensionId === right.extensionId && left.extensionVersion === right.extensionVersion
    && left.skillId === right.skillId && left.commandId === right.commandId
}

export function selectedInvocations(prompt: string, options: ExtensionInvocation[]): ExtensionInvocation[] {
  return splitComposerPrompt(prompt).tokens.flatMap((token) => options.find((option) => option.token === token) ?? [])
}
