import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { detectTeamEngine } from '../team-engine.ts'
import { TeamExecution } from './team-execution.tsx'

describe('专家团执行方式说明', () => {
  it('尚未取得能力信息时不猜测执行方式', () => {
    expect(renderToStaticMarkup(<TeamExecution engine={undefined} locale="zh"/>)).toBe('')
  })

  it('保留真实的执行模式和原因，包括已启用但受深度限制的情况', () => {
    const engines = [
      detectTeamEngine(undefined, false),
      detectTeamEngine(undefined, true),
      { state: 'enabled' as const, mode: 'native' as const, reason: 'Agent Team 已启用，使用原生团队协作。', recommendation: '' },
      { state: 'enabled' as const, mode: 'subagent' as const,
        reason: '原生 Agent Team 暂不支持本插件配置的深度限制，本次使用普通子代理以保留该限制。', recommendation: '' },
    ]
    const output = engines.map(engine => renderToStaticMarkup(<TeamExecution engine={engine} locale="zh"/>))
    expect(output[2]).toContain('默认执行方式：原生智能体团队')
    expect(output[3]).toContain('默认执行方式：普通子代理')
    expect(output[3]).toContain('深度限制')
    expect(output.every(text => text.includes('实际方式以本次召唤结果为准'))).toBe(true)
    expect(output).toMatchSnapshot()
  })

  it('语言切换后重新翻译服务端返回的原因', () => {
    const output = renderToStaticMarkup(<TeamExecution engine={detectTeamEngine(undefined, true)} locale="en"/>)
    expect(output).toContain('Default execution mode：Standard subagents')
    expect(output).not.toMatch(/[\u3400-\u9fff]/u)
    expect(output).toMatchSnapshot()
  })
})
