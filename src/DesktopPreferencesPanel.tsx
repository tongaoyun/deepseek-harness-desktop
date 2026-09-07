import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { defaultDesktopPreferences, saveDesktopPreferences, useDesktopPreferences, type DesktopPreferences } from './desktopPreferences'
export function DesktopPreferencesPanel() {
  const value = useDesktopPreferences()
  const [error, setError] = useState('')
  const save = (patch: Partial<DesktopPreferences>) => {
    try { saveDesktopPreferences({ ...value, ...patch }); setError('') }
    catch { setError('偏好设置保存失败，请检查本机存储后重试。') }
  }
  return <section className="settings-panel preferences-panel"><header><span><SlidersHorizontal size={18} /></span><div><h2>偏好设置</h2><p>调整阅读和交互体验，在本机保存并立即生效。</p></div></header>
    <label><span><strong>对话字号</strong><small>调整任务正文与输入框的文字大小</small></span><select aria-label="对话字号" value={value.fontSize} onChange={(event) => save({ fontSize: Number(event.target.value) as DesktopPreferences['fontSize'] })}><option value={14}>默认</option><option value={16}>较大</option><option value={18}>大</option></select></label>
    <label><span><strong>对话宽度</strong><small>同时调整消息与输入框，不影响文件预览</small></span><select aria-label="对话宽度" value={value.wide ? 'wide' : 'default'} onChange={(event) => save({ wide: event.target.value === 'wide' })}><option value="default">默认</option><option value="wide">宽</option></select></label>
    <label><span><strong>减少动画</strong><small>关闭装饰性过渡；未开启时仍遵循系统偏好</small></span><input aria-label="减少动画" role="switch" type="checkbox" checked={value.reduceMotion} onChange={(event) => save({ reduceMotion: event.target.checked })} /></label>
    {error && <p role="alert">{error}</p>}<button type="button" onClick={() => save(defaultDesktopPreferences)}>恢复默认</button>
  </section>
}
