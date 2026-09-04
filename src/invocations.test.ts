import { describe, expect, it } from 'vitest'
import { buildInvocationOptions, filterInvocationOptions } from './invocations'
import type { ExpertKitView } from './expertKits'

const kit = {
  id: 'ops', name: '运营专家', version: '1.0.0', summary: '运营', category: 'ecommerce-retail', minimumDesktopVersion: '0.1.0',
  commandIds: ['daily-report'], skillIds: ['inventory'], connectorRefs: [], knowledgeBaseRefs: [], requiredTools: [],
  serverWorkflows: [], sha256: 'x', installState: 'installed', readiness: 'ready', connectorIssues: [], knowledgeIssues: [], localOnly: false,
} as ExpertKitView

describe('slash invocation options', () => {
  it('includes only installed kit commands and filters by id', () => {
    const options = buildInvocationOptions([kit])
    expect(options.map((item) => item.label)).toEqual(['/daily-report'])
    expect(filterInvocationOptions(options, '/daily')).toHaveLength(1)
    expect(filterInvocationOptions(options, '/daily-report ')).toEqual([])
  })

  it('keeps the installed version commands available when an update exists', () => {
    const update = {
      ...kit,
      version: '2.0.0',
      commandIds: ['new-report'],
      skillIds: ['new-inventory'],
      installState: 'update',
      installed: {
        manifest: {
          id: 'ops', name: '运营专家', version: '1.0.0', commands: [{ id: 'daily-report', path: 'commands/daily.md' }],
          skills: [{ id: 'inventory', path: 'skills/inventory' }],
        },
      },
    } as ExpertKitView
    expect(buildInvocationOptions([update]).map((item) => item.label))
      .toEqual(['/daily-report'])
  })
})
