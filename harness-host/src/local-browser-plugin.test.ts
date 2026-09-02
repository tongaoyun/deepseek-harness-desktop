import { describe, expect, it } from 'vitest'
import { browserApprovalReason, validateBrowserUrl, validateDebugUrl } from './local-browser-plugin.js'

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

  it('only attaches to a local shared browser debugging endpoint', () => {
    expect(validateDebugUrl('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(() => validateDebugUrl('https://127.0.0.1:9222')).toThrow('local HTTP')
    expect(() => validateDebugUrl('http://browser.internal:9222')).toThrow('local HTTP')
  })
})
