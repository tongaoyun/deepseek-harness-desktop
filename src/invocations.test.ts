import { describe, expect, it } from 'vitest'
import { buildInvocationOptions, filterInvocationOptions } from './invocations'
import type { ExpertKitView } from './expertKits'

const kit = {
  id: 'ops', name: '运营专家', version: '1.0.0', summary: '运营', minimumDesktopVersion: '0.1.0',
  commandIds: ['daily-report'], skillIds: ['inventory'], connectorRefs: [], knowledgeBaseRefs: [], requiredTools: [],
  permissions: { localFiles: 'deny', shell: 'deny', computerUse: 'deny', connectorRead: 'deny', connectorWrite: 'deny' },
  serverWorkflows: [], sha256: 'x', installState: 'installed', readiness: 'ready', connectorIssues: [], knowledgeIssues: [], localOnly: false,
} as ExpertKitView

describe('slash invocation options', () => {
  it('includes installed kit commands and skills and filters by id', () => {
    const options = buildInvocationOptions([kit], [{
      id: 'inventory', name: '库存分析', version: '1', summary: '分析库存', sourceKitId: 'ops', triggers: [],
    }])
    expect(options.map((item) => item.label)).toEqual(['/daily-report', '/inventory'])
    expect(filterInvocationOptions(options, '/inv')).toHaveLength(1)
    expect(filterInvocationOptions(options, '/inventory ')).toEqual([])
  })
})
