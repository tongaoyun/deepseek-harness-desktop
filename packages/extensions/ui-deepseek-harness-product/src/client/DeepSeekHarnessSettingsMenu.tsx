import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconEllipsisOutlineMedium, IconSettingsOutlineMedium, IconQuestionOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState } from 'react'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { DesktopFeedback } from './DesktopFeedback.tsx'

/** DeepSeekHarness owns enterprise authentication, so its launcher deliberately has no Harness account action. */
export function DeepSeekHarnessSettingsMenu({ wide, settingsShortcut, openSettings, t }:
PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS>) {
  const [open, setOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <div className={css.menuRoot}>
    <Menu open={open} side="top" portal autoFocus className={css.menuAnchor} listClassName={css.menuList}
      anchor={<button ref={trigger} type="button" className={css.menuTrigger} data-collapsed={!wide}
        aria-label={t('menu')} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <IconEllipsisOutlineMedium size={14} />
        {wide && <span className={css.menuLabel}>{t('more')}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        { id: 'feedback', label: t('feedbackTitle'), icon: <IconQuestionOutlineRegular size={16} /> },
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        trigger.current?.focus()
        if (id === 'settings') openSettings()
        if (id === 'feedback') setFeedbackOpen(true)
      }} />
    <DesktopFeedback open={feedbackOpen} onClose={() => { setFeedbackOpen(false) }} t={t} />
  </div>
}
