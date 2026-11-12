import { createRoot } from 'react-dom/client'
import { LibraryConfirm } from './library-ui.tsx'
import { teamText, type TeamLocale } from '../team-i18n.ts'

/** 使用原生主题弹窗确认插入；页面退出或所属操作取消时关闭并返回 false。
 * @param message 待确认的草稿操作。
 * @param locale 界面语言。
 * @param signal 所属连接和插件的生命周期。
 * @returns 用户是否确认；取消后释放弹窗和监听器。
 */
export function confirmTeamAction(message: string, locale: TeamLocale, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let settled = false
    const finish = (accepted: boolean) => {
      if (settled) return
      settled = true
      window.removeEventListener('pagehide', cancel)
      signal?.removeEventListener('abort', cancel)
      resolve(accepted)
      queueMicrotask(() => { root.unmount(); container.remove() })
    }
    const cancel = () => finish(false)
    window.addEventListener('pagehide', cancel, { once: true })
    signal?.addEventListener('abort', cancel, { once: true })
    root.render(<LibraryConfirm title={teamText(locale, '确认选择专家团')} description={message} cancelLabel={teamText(locale, '取消')}
      confirmLabel={teamText(locale, '确认')} close={cancel} confirm={() => finish(true)} />)
  })
}
