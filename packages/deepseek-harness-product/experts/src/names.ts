/** 跨境电商 ERP 的业务分类；筛选、编辑和专家团选人使用相同顺序。 */
export const EXPERT_CATEGORIES = [
  { id: 'orders', zh: '订单与售后', en: 'Orders & After-sales' },
  { id: 'catalog', zh: '商品与刊登', en: 'Products & Listings' },
  { id: 'supply-chain', zh: '采购与供应链', en: 'Procurement & Supply Chain' },
  { id: 'warehouse', zh: '库存与仓储', en: 'Inventory & Warehousing' },
  { id: 'logistics', zh: '物流与履约', en: 'Logistics & Fulfillment' },
  { id: 'finance', zh: '财务与对账', en: 'Finance & Reconciliation' },
  { id: 'marketplace', zh: '平台与店铺', en: 'Platforms & Stores' },
  { id: 'marketing', zh: '运营与增长', en: 'Operations & Growth' },
  { id: 'analytics', zh: '数据与经营分析', en: 'Data & Business Analytics' },
  { id: 'product', zh: '产品与设计', en: 'Product & Design' },
  { id: 'engineering', zh: '研发与集成', en: 'Engineering & Integration' },
  { id: 'testing', zh: '测试与运维', en: 'Quality & Operations' },
  { id: 'support', zh: '实施与客户支持', en: 'Implementation & Customer Support' },
  { id: 'company', zh: '企业协作', en: 'Enterprise Collaboration' },
  { id: 'specialized', zh: '其他', en: 'Other' },
] as const

/** 企业分类的固定展示顺序，目录可补充自定义分类。 */
export const EXPERT_DIVISION_ORDER = EXPERT_CATEGORIES.map(category => category.id)

function divisionLabels(locale: 'zh' | 'en'): Readonly<Record<string, string>> {
  const labels = Object.fromEntries(EXPERT_CATEGORIES.map(category => [category.id, category[locale]]))
  Object.setPrototypeOf(labels, null)
  return labels
}

/** 分类目录名到中文显示名；自定义分类不匹配对象原型属性。 */
export const ZH_DIVISION = divisionLabels('zh')

/** 分类目录名到英文显示名；自定义分类不匹配对象原型属性。 */
export const EN_DIVISION = divisionLabels('en')
