import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconEllipsisOutlineMedium, IconSettingsOutlineMedium, IconQuestionOutlineRegular, IconDownloadOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { DesktopFeedback } from './DesktopFeedback.tsx'

/** DeepSeekHarness owns enterprise authentication, so its launcher deliberately has no Harness account action. */
export function DeepSeekHarnessSettingsMenu({ wide, settingsShortcut, openSettings, openSoftwareUpdate, t }:
PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS> & { readonly openSoftwareUpdate?: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [updateError, setUpdateError] = useState(false)
  const [updatePending, setUpdatePending] = useState(false)
  const operation = useRef({ live: true, pending: false })
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    operation.current.live = true
    return () => { operation.current.live = false }
  }, [])
  const update = async () => {
    if (openSoftwareUpdate === undefined || operation.current.pending) return
    operation.current.pending = true
    setUpdatePending(true); setUpdateError(false)
    try { await openSoftwareUpdate() }
    catch { if (operation.current.live) setUpdateError(true) }
    finally {
      operation.current.pending = false
      if (operation.current.live) setUpdatePending(false)
    }
  }
  return <div className={css.menuRoot}>
    {updateError && <p role="alert" className={css.catalogError}>{t('softwareUpdateFailed')}</p>}
    <Menu open={open} side="top" portal autoFocus className={css.menuAnchor} listClassName={css.menuList}
      anchor={<button ref={trigger} type="button" className={css.menuTrigger} data-collapsed={!wide}
        aria-label={t('menu')} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <IconEllipsisOutlineMedium size={14} />
        {wide && <span className={css.menuLabel}>{t('more')}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        ...openSoftwareUpdate === undefined ? [] : [
          { id: 'software-update', label: t('softwareUpdate'), icon: <IconDownloadOutlineRegular size={16} />, disabled: updatePending },
        ],
        { id: 'feedback', label: t('feedbackTitle'), icon: <IconQuestionOutlineRegular size={16} /> },
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        trigger.current?.focus()
        if (id === 'settings') openSettings()
        if (id === 'feedback') setFeedbackOpen(true)
        if (id === 'software-update') void update()
      }} />
    <DesktopFeedback open={feedbackOpen} onClose={() => { setFeedbackOpen(false) }} t={t} />
  </div>
}
