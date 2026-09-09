import { useEffect, useRef, useState } from 'react'
import { ExternalLink, KeyRound, LoaderCircle, Unplug } from 'lucide-react'
import { connectorAuthorization, type ConnectorAuthorizationState } from './connectorAuthorization'
import type { ConnectorRuntimeDefinition } from './types'

export function ConnectorAccount({ employeeId, connector, onConnected, onDisconnected }: {
  employeeId: string
  connector: ConnectorRuntimeDefinition
  onConnected: () => void
  onDisconnected: () => void
}) {
  const [state, setState] = useState<ConnectorAuthorizationState>()
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const busy = useRef(false)
  useEffect(() => {
    let active = true
    void connectorAuthorization(employeeId, connector, 'status').then(value => { if (active) setState(value) })
      .catch(reason => { if (active) setError(String(reason)) })
    return () => {
      active = false; generation.current += 1
      if (busy.current) void connectorAuthorization(employeeId, connector, 'cancel').catch(() => {})
    }
  }, [employeeId, connector])
  async function run(next: 'authorize' | 'disconnect') {
    if (busy.current) return
    busy.current = true
    const current = ++generation.current
    setAction(next); setError(''); setNotice('')
    try {
      const value = await connectorAuthorization(employeeId, connector, next)
      if (current !== generation.current) return
      setState(value)
      if (next === 'authorize') onConnected()
      else {
        onDisconnected()
        if (!value.revoked) setNotice('本机授权已移除；服务端授权可在账户的应用管理中撤销。')
      }
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { busy.current = false; if (current === generation.current) setAction('') }
  }
  return <div className="connector-account">
    <div className="connector-health-row"><KeyRound size={14} /><strong>{action === 'authorize' ? '等待浏览器授权' : state?.status === 'authorized' ? '账户已授权' : '账户未连接'}</strong></div>
    {state?.scope && <div className="connector-account-scopes"><span>已授予权限</span><ul>{state.scope.split(/\s+/).map(scope => <li key={scope}>{scope}</li>)}</ul></div>}
    {error && <p className="connector-diagnostic-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="connector-account-actions">
      <button className="connector-detail-primary" disabled={Boolean(action)} type="button" onClick={() => void run('authorize')}>{action === 'authorize' ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />}{action === 'authorize' ? '正在授权…' : state?.status === 'authorized' ? '重新授权' : '连接账户'}</button>
      {action === 'authorize' ? <button className="connector-inline-config" type="button" onClick={() => {
        void connectorAuthorization(employeeId, connector, 'cancel').catch(reason => setError(String(reason)))
      }}>取消授权</button> : state?.status === 'authorized' && <button className="connector-inline-config" type="button" disabled={Boolean(action)} onClick={() => void run('disconnect')}><Unplug size={14} />断开账户</button>}
    </div>
  </div>
}
