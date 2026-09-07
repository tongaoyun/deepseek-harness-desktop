import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, runComputerUsePreflight, validateToolSelection } from './local-computer-use-plugin.js'

describe('Windows Computer Use', () => {
  it.skipIf(!['darwin', 'win32'].includes(process.platform))('exposes folder navigation and address-bar shortcut keys', async () => {
    const definitions: unknown[] = []
    const ctx = {
      tools: { register(definition: unknown) { definitions.push(definition); return () => {} } },
      effect() {},
    } as unknown as Context
    await apply(ctx, { enabled: true, tools: ['computer_use_key'] })
    const schema = JSON.stringify(definitions)
    expect(schema).toContain('"G"')
    expect(schema).toContain('"L"')
    expect(schema).toContain('"SHIFT"')
    expect(schema).toContain('"WIN"')
  })

  it('accepts only the built-in tool allowlist', () => {
    expect([...validateToolSelection(['computer_use_observe', 'computer_use_click'])]).toEqual([
      'computer_use_observe', 'computer_use_click',
    ])
    expect(() => validateToolSelection(['computer_use_run_script'])).toThrow(/Unsupported Computer Use tools/)
  })

  it('validates the native bridge before an interactive observation', async () => {
    const payload = Buffer.from(JSON.stringify({
      interactiveDesktop: false,
      sessionId: 0,
      screen: { width: 1024, height: 768 },
    })).toString('base64')
    await expect(runComputerUsePreflight(new AbortController().signal, async () => payload)).resolves.toEqual({
      interactiveDesktop: false,
      sessionId: 0,
      screen: { width: 1024, height: 768 },
    })
    await expect(runComputerUsePreflight(new AbortController().signal, async () => 'invalid output'))
      .rejects.toThrow(/valid result/)
  })
})
