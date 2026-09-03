export const extensionCategories = [
  { id: 'office-productivity', label: '办公效率' },
  { id: 'content-creation', label: '内容创作' },
  { id: 'marketing', label: '市场营销' },
  { id: 'ecommerce-retail', label: '电商零售' },
  { id: 'finance', label: '金融财务' },
  { id: 'legal', label: '法律' },
  { id: 'recruiting', label: '人力招聘' },
  { id: 'code-development', label: '代码开发' },
  { id: 'code-review', label: '代码评审' },
  { id: 'security-testing', label: '安全与测试' },
  { id: 'database-analysis', label: '数据库与分析' },
  { id: 'operations-deployment', label: '运维部署' },
  { id: 'developer-tools', label: '开发者工具' },
  { id: 'design', label: '设计' },
  { id: 'product-management', label: '产品管理' },
  { id: 'knowledge-research', label: '知识研究' },
  { id: 'workflow', label: '工作流' },
  { id: 'agent-evolution', label: 'Agent 自进化' },
  { id: 'communication', label: '通讯' },
  { id: 'other', label: '其他' },
] as const

export const connectorCategories = [
  { id: 'recommended-system', label: '推荐/系统级' },
  { id: 'communication-collaboration', label: '沟通协作' },
  { id: 'project-management', label: '项目管理' },
  { id: 'knowledge-documents', label: '知识文档' },
  { id: 'developer-tools', label: '开发工具' },
  { id: 'design-creative', label: '设计创意' },
  { id: 'schedule-productivity', label: '日程效率' },
  { id: 'maps-travel', label: '地图出行' },
  { id: 'industry-data', label: '行业数据' },
  { id: 'other', label: '其他' },
] as const

export type ExtensionCategory = typeof extensionCategories[number]['id']
export type ConnectorCategory = typeof connectorCategories[number]['id']
export type ExtensionCategoryFilter = 'all' | ExtensionCategory

export function extensionCategoryLabel(category: string): string {
  return extensionCategories.find((item) => item.id === category)?.label ?? '其他'
}

export function connectorCategoryLabel(category: string): string {
  return connectorCategories.find((item) => item.id === category)?.label ?? '其他'
}
