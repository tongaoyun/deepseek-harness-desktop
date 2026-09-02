import { describe, expect, it } from 'vitest'
import { browserApprovalReason, validateBrowserUrl } from './local-browser-plugin.js'

describe('local browser connector', () => {
  it('accepts normal web pages and rejects unsafe URL forms', () => {
    expect(validateBrowserUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(() => validateBrowserUrl('file:///etc/passwd')).toThrow('HTTP(S)')
    expect(() => validateBrowserUrl('https://user:pass@example.com')).toThrow('credentials')
  })

  it('creates bounded approval descriptions for browser mutations', () => {
    expect(browserApprovalReason('browser_click', { selector: '#submit' })).toBe('点击浏览器元素 #submit')
    expect(browserApprovalReason('browser_type', { selector: 'input[name=q]' })).toContain('输入内容')
  })
})
