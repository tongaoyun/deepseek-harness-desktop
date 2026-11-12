import { CONTENT_CATEGORIES } from '@deepseek-harness/product/content-categories'

/** 筛选、编辑和专家团选人使用相同的业务分类。 */
export const EXPERT_CATEGORIES = CONTENT_CATEGORIES


/** 企业分类的固定展示顺序。 */
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
