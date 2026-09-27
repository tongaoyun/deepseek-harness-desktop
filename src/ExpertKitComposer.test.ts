import { describe, expect, it } from 'vitest'
import { composerIssues, deriveSkillDependencies } from './ExpertKitComposer'
import { isDesktopToolName } from './expertKits'
import type { SkillView } from './skills'
import type { ConnectorCatalogEntry } from './types'

const connector: ConnectorCatalogEntry = {
  id: 'erp-mcp', name: 'ERP', summary: '', category: 'industry-data', kind: 'managed-mcp', scope: 'PERSONAL', status: 'ready', managed: false,
  transport: 'streamable-http', url: 'https://mcp.example.com', authMode: 'none', toolNames: ['order.search'],
}

const skill = {
  id: 'order-review', name: '订单检查', version: '1.0.0', summary: '', category: 'ecommerce-retail', sourceKitId: '', triggers: ['检查订单'],
  minimumDesktopVersion: '0.1.29', connectorRefs: ['erp-mcp'], requiredTools: ['order.search'], knowledgeBaseRefs: [],
  sha256: 'a'.repeat(64), installState: 'installed', readiness: 'ready', connectorIssues: [], knowledgeIssues: [],
  installed: {
    installPath: '/skills/order-review/1.0.0', source: 'catalog',
    manifest: {
      schemaVersion: '1', kind: 'skill', id: 'order-review', name: '订单检查', version: '1.0.0', summary: '', category: 'ecommerce-retail',
      triggers: ['检查订单'], minimumDesktopVersion: '0.1.29', commands: [], skills: [{ id: 'order-review', path: 'SKILL.md' }],
      connectorRefs: ['erp-mcp'], requiredTools: ['order.search'], knowledgeBaseRefs: [],
    },
  },
} as SkillView

describe('expert kit composer', () => {
  it('recognizes every official Playwright MCP tool as a Harness capability', () => {
    expect(isDesktopToolName('mcp__playwright-mcp__browser_run_code_unsafe')).toBe(true)
    expect(isDesktopToolName('mcp__playwright-mcp__browser_future_tool')).toBe(true)
    expect(isDesktopToolName('browser_navigate')).toBe(false)
  })

  it('derives connector and tool requirements from selected skills', () => {
    expect(deriveSkillDependencies([skill], ['order-review'])).toEqual({
      connectorIds: ['erp-mcp'],
      tools: ['order.search'],
    })
  })

  it('reports missing dependencies and becomes ready after auto selection', () => {
    expect(composerIssues([skill], [connector], ['order-review'], [], [])).toEqual([
      '所选技能依赖连接器 erp-mcp',
      '所选技能依赖工具 order.search',
      'order.search 没有可用的连接器提供',
    ])
    expect(composerIssues([skill], [connector], ['order-review'], ['erp-mcp'], ['order.search'])).toEqual([])
  })
})
