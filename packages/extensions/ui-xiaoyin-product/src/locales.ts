/** Locale namespace used by the Xiaoyin product extension. */
export const NS = 'xiaoyinProduct'

/** Simplified Chinese labels for the Xiaoyin product extension. */
export const zh = {
  title: '小胤产品',
  unavailable: '产品服务未连接',
  loading: '加载中…',
  empty: '暂无数据',
  expertKits: '专家套件',
  skills: '技能',
  connectors: '连接器',
  knowledge: '知识库',
  schedules: '定时任务',
  im: '钉钉 IM',
  refresh: '刷新',
  close: '关闭',
  open: '打开小胤产品',
} as const

/** English labels for the Xiaoyin product extension. */
export const en = {
  title: 'Xiaoyin products',
  unavailable: 'Product services unavailable',
  loading: 'Loading…',
  empty: 'No data',
  expertKits: 'Expert kits',
  skills: 'Skills',
  connectors: 'Connectors',
  knowledge: 'Knowledge bases',
  schedules: 'Schedules',
  im: 'DingTalk IM',
  refresh: 'Refresh',
  close: 'Close',
  open: 'Open Xiaoyin products',
} as const

/** Supported translation keys in the Xiaoyin product namespace. */
export type XiaoyinProductKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    xiaoyinProduct: XiaoyinProductKey
  }
}
