/** Locale namespace used by the Xiaoyin product extension. */
export const NS = 'xiaoyinProduct'

/** Simplified Chinese labels for the Xiaoyin product extension. */
export const zh = {
  title: '小胤产品',
  unavailable: '产品服务未连接',
  authRequired: '需要登录企业钉钉后才能使用专家套件、技能、连接器和知识库。',
  signIn: '使用钉钉登录',
  signInFailed: '钉钉登录未完成，请重试。',
  loadFailed: '产品目录暂时无法加载，请稍后重试。',
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
  authRequired: 'Sign in with your organization DingTalk account to use product capabilities.',
  signIn: 'Sign in with DingTalk',
  signInFailed: 'DingTalk sign-in did not complete. Try again.',
  loadFailed: 'Product catalogs are temporarily unavailable. Try again later.',
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
