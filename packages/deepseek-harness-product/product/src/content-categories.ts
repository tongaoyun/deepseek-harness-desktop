const OTHER_CONTENT_CATEGORY = { id: 'specialized', zh: '其他', en: 'Other' } as const

/** 技能、专家和专家团选人的固定业务分类。 */
export const CONTENT_CATEGORIES = [
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
  OTHER_CONTENT_CATEGORY,
] as const

/** 将分类标识或中英文名称解析为预设分类；空值及其他名称归入“其他”。
 * @param value 包或目录保存的原始分类，不改写其元数据。
 * @returns 固定分类及其中英文名称。
 */
export function resolveContentCategory(value: string | null | undefined): typeof CONTENT_CATEGORIES[number] {
  const normalized = value?.trim().toLowerCase()
  return CONTENT_CATEGORIES.find(category => category.id === normalized
    || category.zh === normalized
    || category.en.toLowerCase() === normalized) ?? OTHER_CONTENT_CATEGORY
}
