import { BrainCircuit, HardDrive, Keyboard, RefreshCw, SlidersHorizontal, UserRound } from 'lucide-react'
import { DesktopPreferencesPanel } from './DesktopPreferencesPanel'
import { AttachmentStoragePanel } from './AttachmentStoragePanel'
import { useState } from 'react'
import { DesktopUpdater } from './DesktopUpdater'
import { MemoryPage } from './MemoryPage'
import type { MemoryProfile } from './memory'
import { isUpdatableDesktop } from './updater'

interface DesktopSettingsPageProps {
  accessToken: string
  employeeId: string
  memoryEndpoint: string
  memoryAvailable?: boolean
  displayName: string
  department: string
  position: string
  companyName: string
  onMemorySaved: (profile: MemoryProfile) => Promise<void> | void
  onOpenMemoryTask?: (id: string) => void
}

type SettingsSection = 'preferences' | 'profile' | 'shortcuts' | 'memory' | 'updates' | 'storage'

export function DesktopSettingsPage({
  accessToken,
  employeeId,
  memoryEndpoint,
  memoryAvailable = true,
  displayName,
  department,
  position,
  companyName,
  onMemorySaved,
  onOpenMemoryTask,
}: DesktopSettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('preferences')
  const windowsDesktop = isUpdatableDesktop()
  const visibleSection = section === 'updates' && !windowsDesktop
    ? 'profile'
    : section === 'memory' && !memoryAvailable ? 'preferences' : section

  return <div className="desktop-settings">
    <aside className="settings-navigation" aria-label="桌面设置">
      <p>通用</p>
      <button className={section === 'preferences' ? 'active' : ''} onClick={() => setSection('preferences')} type="button"><SlidersHorizontal size={17} /><span><strong>偏好设置</strong><small>字号、宽度与动画</small></span></button>
      <button className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')} type="button">
        <UserRound size={17} /><span><strong>个人资料</strong><small>企业身份与账户信息</small></span>
      </button>
      <button className={section === 'shortcuts' ? 'active' : ''} onClick={() => setSection('shortcuts')} type="button">
        <Keyboard size={17} /><span><strong>快捷键</strong><small>常用桌面操作</small></span>
      </button>
      <button className={section === 'memory' ? 'active' : ''} disabled={!memoryAvailable} onClick={() => setSection('memory')} type="button">
        <BrainCircuit size={17} /><span><strong>记忆</strong><small>{memoryAvailable ? '工作方式与长期偏好' : '企业服务连接后可用'}</small></span>
      </button>
      {windowsDesktop && <button className={visibleSection === 'updates' ? 'active' : ''} onClick={() => setSection('updates')} type="button">
        <RefreshCw size={17} /><span><strong>更新应用</strong><small>检查桌面端新版本</small></span>
      </button>}
      <button className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')} type="button"><HardDrive size={17} /><span><strong>附件存储</strong><small>占用统计与未引用缓存清理</small></span></button>
    </aside>
    <section className="settings-content">
      {visibleSection === 'preferences' ? <DesktopPreferencesPanel /> : visibleSection === 'storage' ? <AttachmentStoragePanel /> : visibleSection === 'profile'
        ? <section className="profile-settings settings-panel"><header><span><UserRound size={18} /></span><div><h2>个人资料</h2><p>当前登录的企业账号信息。</p></div></header><dl><div><dt>姓名</dt><dd>{displayName}</dd></div><div><dt>员工账号</dt><dd>{employeeId}</dd></div><div><dt>部门</dt><dd>{department || '未设置'}</dd></div><div><dt>岗位</dt><dd>{position || '未设置'}</dd></div><div><dt>企业</dt><dd>{companyName}</dd></div></dl></section>
        : visibleSection === 'memory'
        ? <MemoryPage
            accessToken={accessToken}
            employeeId={employeeId}
            endpoint={memoryEndpoint}
            onSaved={onMemorySaved}
            onOpenTask={onOpenMemoryTask}
          />
        : visibleSection === 'shortcuts'
            ? <section className="shortcut-settings settings-panel"><header><span><Keyboard size={18} /></span><div><h2>键盘快捷键</h2><p>以下快捷键在小胤任意页面可用。</p></div></header><dl><div><dt>搜索任务</dt><dd><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd><small>macOS 使用 ⌘ K</small></dd></div><div><dt>发送消息</dt><dd><kbd>Enter</kbd><small>Shift + Enter 换行</small></dd></div><div><dt>关闭菜单或弹窗</dt><dd><kbd>Esc</kbd></dd></div><div><dt>拖入本地文件</dt><dd><span>直接拖到对话</span><small>自动授权文件所在目录</small></dd></div></dl></section>
            : <section className="update-settings settings-panel"><header><span><RefreshCw size={18} /></span><div><h2>更新应用</h2><p>检查并安装小胤桌面端的新版本。</p></div></header><div><DesktopUpdater /></div></section>}
    </section>
  </div>
}
