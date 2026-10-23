import type { TeamEngineStatus } from '../team-contract.ts'
import { teamText, type TeamLocale } from '../team-i18n.ts'

/** Catalog status describes the default; invocation resolves the current Agent's tools again. */
export function TeamExecution({ engine, locale }: { engine: TeamEngineStatus | undefined; locale: TeamLocale }) {
  if (!engine) return null
  const tx = (key: string) => teamText(locale, key)
  return <details className="aag-note agt-engine">
    <summary>{tx('默认执行方式')}：{tx(engine.mode === 'native' ? '原生智能体团队' : '普通子代理')}</summary>
    <p>{tx(engine.reason)}</p>
    {engine.recommendation && <p>{tx(engine.recommendation)}</p>}
    <p>{tx('执行前会再次检查当前会话的可用能力，实际方式以本次召唤结果为准。')}</p>
  </details>
}
