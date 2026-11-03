import { teamText, type TeamLocale } from './team-i18n.ts'

const messages = {
  CATALOG_READ_FAILED: '无法读取专家目录，请刷新后重试。',
  PERSONA_NOT_FOUND: '未找到专家提示词。',
  PERSONA_READ_FAILED: '无法读取专家提示词。',
} as const

/** 目录和正文读取保留文件系统原因，公开文案不包含本地路径。 */
export class PersonaError extends Error {
  constructor(readonly code: keyof typeof messages, locale: TeamLocale, cause?: unknown) {
    super(teamText(locale, messages[code]), { cause })
    this.name = 'PersonaError'
  }
}
