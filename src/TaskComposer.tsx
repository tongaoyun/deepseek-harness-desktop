import { ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, FilePlus2, FolderPlus, History, LoaderCircle, Plug, Plus, Puzzle, Search, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatPageProps } from './ChatPage'
import { composerQuery, joinComposerPrompt, removeComposerQuery, selectComposerInvocation, splitComposerPrompt } from './composerInput'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerAttachments } from './ComposerAttachments'
import type { LocalArtifactTarget } from './localArtifactPreview'

type Category = 'expert-kit' | 'skill' | 'connector' | 'knowledge'
const categories: { id: Category; label: string; icon: typeof Puzzle }[] = [
  { id: 'expert-kit', label: '专家套件', icon: Puzzle }, { id: 'skill', label: '技能', icon: Sparkles },
  { id: 'connector', label: '连接器', icon: Plug }, { id: 'knowledge', label: '知识库', icon: BookOpen },
]
interface Option { id: string; name: string; description: string; selected?: boolean; disabled?: boolean; choose: () => void }
const recentDirectoryLabel = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/u, '~')

export function TaskComposer(props: ChatPageProps & { onPreview: (target: LocalArtifactTarget) => void }) {
  const [checkingClipboard, setCheckingClipboard] = useState(false)
  const [pasteError, setPasteError] = useState('')
  const pasteRequest = useRef(0)
  const pasteView = useRef({ prompt: props.prompt, taskId: props.taskId })
  pasteView.current = { prompt: props.prompt, taskId: props.taskId }
  useEffect(() => () => { pasteRequest.current += 1 }, [])
  const running = props.currentTaskRunning ?? props.harnessRunning
  const stopping = running && props.taskProjection.activity === '正在停止'
  const locked = running || props.taskContextRestoring || props.pastingAttachments || checkingClipboard
  // A disabled send with no explanation reads as "the button is broken".
  const blockedReason = props.runtimeStatus !== 'ready' ? '企业服务未连接，正在重连'
    : props.harnessHealth === 'degraded' ? '本地 Agent 不可用，请先恢复'
    : props.taskContextRestoring ? '正在恢复任务上下文'
    : props.pastingAttachments ? '正在添加附件'
    : checkingClipboard ? '正在读取剪贴板'
    : ''
  const [menu, setMenu] = useState<'context' | 'directory'>()
  const [recentOpen, setRecentOpen] = useState(false)
  const [directoryAbove, setDirectoryAbove] = useState(false)
  const [directoryAlignEnd, setDirectoryAlignEnd] = useState(false)
  const [recentToLeft, setRecentToLeft] = useState(false)
  const [category, setCategory] = useState<Category>('expert-kit')
  const [search, setSearch] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const contextPicker = useRef<HTMLDivElement>(null)
  const directoryPicker = useRef<HTMLDivElement>(null)
  const directoryMenu = useRef<HTMLDivElement>(null)
  const recentMenu = useRef<HTMLDivElement>(null)
  const recentButton = useRef<HTMLButtonElement>(null)
  const suggestionsPicker = useRef<HTMLDivElement>(null)
  const menuSearch = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const directoryButton = useRef<HTMLButtonElement>(null)
  const { tokens, text } = splitComposerPrompt(props.prompt)
  // With one capability chosen, its own description says what it does until the employee types.
  const capabilityHint = tokens.length === 1
    ? props.invocations?.find((item) => item.token === tokens[0])?.description
    : undefined
  const [caret, setCaret] = useState(text.length)
  const [optionIndex, setOptionIndex] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const queryKey = `${text}:${caret}`
  const query = !locked && dismissed !== queryKey ? composerQuery(text, caret) : undefined
  const listId = useId()
  const recentMenuId = useId()
  const closeMenu = () => { setMenu(undefined); setRecentOpen(false); setSearch('') }
  const focusInput = (position?: number) => window.requestAnimationFrame(() => {
    props.composerRef.current?.focus()
    if (position !== undefined) props.composerRef.current?.setSelectionRange(position, position)
  })
  const finishReference = () => {
    if (query) { props.onPrompt(joinComposerPrompt(tokens, removeComposerQuery(text, query))); setCaret(query.start); focusInput(query.start) }
    else focusInput()
    closeMenu(); setOptionIndex(0)
  }
  const extensionOptions = (kind?: 'skill' | 'expert-kit'): Option[] => (props.invocations ?? [])
    .filter((item) => !item.bundledSkill && (!kind || item.kind === kind)).map((item) => ({
    id: item.token, name: item.name, description: item.description, selected: tokens.includes(item.token),
    disabled: tokens.length >= 8 && !tokens.some((token) => token.split(':').slice(0, 2).join(':') === item.token.split(':').slice(0, 2).join(':')),
    choose: () => { props.onPrompt(selectComposerInvocation(props.prompt, item, query)); closeMenu(); setOptionIndex(0); setDismissed(''); setCaret(query?.start ?? text.length); focusInput(query?.start ?? text.length) },
  }))
  const knowledgeOptions: Option[] = props.knowledgeBases.map((item) => ({
    id: item.reference, name: item.name, description: item.description || '检索资料并引用原文', selected: props.selectedKnowledgeBaseRefs.includes(item.reference),
    choose: () => { if (props.selectedKnowledgeBaseRefs.includes(item.reference)) { if (!query) props.onRemoveKnowledge(item.reference) } else props.onAddKnowledge(item.reference); finishReference() },
  }))
  const connectorOptions: Option[] = (props.composerConnectors ?? []).map((item) => ({
    id: item.id, name: item.name, description: item.status === 'ready' && item.enabled ? `${item.toolNames.length} 个工具 · 可用于当前任务` : '尚未就绪，请到连接器页面配置并启用',
    disabled: item.status !== 'ready' || !item.enabled, selected: props.selectedConnectorIds?.includes(item.id),
    choose: () => { if (!query || !props.selectedConnectorIds?.includes(item.id)) props.onToggleTaskConnector?.(item.id); finishReference() },
  }))
  const sessionReferenceOptions: Option[] = (props.sessionReferences ?? []).map((item): Option => ({
    id: `dsh-session:${item.sessionId}`,
    name: item.label,
    description: '引用该会话的只读快照（不可信上下文）',
    choose: () => {
      if (!query) return
      const label = item.label.replace(/[()[\]]/gu, ' ').replace(/\s+/gu, ' ').trim() || item.sessionId
      const encoded = btoa(item.sessionId).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
      const mention = `@[${label}](dsh-session:${encoded})`
      const next = text.slice(0, query.start) + mention + text.slice(query.end)
      props.onPrompt(joinComposerPrompt(tokens, next)); setCaret(query.start + mention.length); closeMenu(); focusInput(query.start + mention.length)
    },
  }))
  const references: Option[] = [...sessionReferenceOptions, ...knowledgeOptions, ...connectorOptions, ...props.localDirectories.map((item): Option => ({
    id: item.id, name: item.name, description: item.path || '当前工作目录',
    choose: () => { if (query) { const next = text.slice(0, query.start) + `「${item.name}」` + text.slice(query.end); props.onPrompt(joinComposerPrompt(tokens, next)); setCaret(query.start + item.name.length + 2) } closeMenu(); focusInput() },
  }))]
  const matches = (item: Option, value: string) => `${item.name} ${item.id} ${item.description}`.toLocaleLowerCase().includes(value.toLocaleLowerCase())
  const suggestions = query ? (query.trigger === '/' ? extensionOptions() : references).filter((item) => matches(item, query.text) && !item.disabled).slice(0, 12) : []
  const menuOptions = (category === 'knowledge' ? knowledgeOptions : category === 'connector' ? connectorOptions : extensionOptions(category)).filter((item) => matches(item, search))
  const recentDirectories = props.recentDirectories ?? []
  const recentPaths = new Set(recentDirectories.map((item) => item.path))
  const availableRecentDirectories = [...recentDirectories, ...props.localDirectories.filter((item) => !item.path || !recentPaths.has(item.path))]
  const activeIndex = Math.min(optionIndex, Math.max(0, suggestions.length - 1))

  useLayoutEffect(() => {
    const input = props.composerRef.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(160, Math.max(44, input.scrollHeight))}px`
  }, [text, props.composerRef])
  useLayoutEffect(() => {
    if (menu !== 'directory') return
    const place = () => {
      const trigger = directoryButton.current?.getBoundingClientRect()
      const panel = directoryMenu.current?.getBoundingClientRect()
      if (!trigger || !panel) return
      const roomBelow = window.innerHeight - trigger.bottom
      const alignEnd = trigger.left + panel.width > window.innerWidth - 12
      const panelLeft = alignEnd ? trigger.right - panel.width : trigger.left
      setDirectoryAbove(roomBelow < panel.height + 12 && trigger.top > roomBelow)
      setDirectoryAlignEnd(alignEnd)
      if (recentOpen && window.innerWidth > 640) {
        const submenu = recentMenu.current?.getBoundingClientRect()
        if (submenu) setRecentToLeft(panelLeft + panel.width + submenu.width > window.innerWidth - 12 && panelLeft >= submenu.width + 12)
      }
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menu, recentOpen, props.localDirectories.length, props.recentDirectories?.length])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (menu === 'context' && !contextPicker.current?.contains(target)) closeMenu()
      if (menu === 'directory' && !directoryPicker.current?.contains(target)) closeMenu()
      if (query && !props.composerRef.current?.contains(target) && !suggestionsPicker.current?.contains(target)) setDismissed(queryKey)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menu, queryKey, Boolean(query)])
  useEffect(() => { if (menu === 'context') menuSearch.current?.focus() }, [menu])
  useEffect(() => {
    if (!menu) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      closeMenu(); (menu === 'context' ? addButton : directoryButton).current?.focus()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [menu])

  const inputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (query && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      if (event.key === 'Enter' && event.shiftKey) return
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(queryKey); return }
      if (suggestions.length) {
        event.preventDefault()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setOptionIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
        else suggestions[activeIndex].choose()
        return
      }
      if (event.key === 'Enter' && /^[/@]\S*$/u.test(text)) { event.preventDefault(); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!props.pastingAttachments && !props.taskContextRestoring) event.currentTarget.form?.requestSubmit() }
  }

  return <div className="task-composer" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape' && menu) {
      event.stopPropagation()
      if (menu === 'directory' && recentOpen) { setRecentOpen(false); recentButton.current?.focus() }
      else { (menu === 'context' ? addButton : directoryButton).current?.focus(); closeMenu() }
    }
  }}>
    <form className="composer" onSubmit={props.onSubmit}>
      {(tokens.length > 0 || props.selectedKnowledgeBaseRefs.length > 0 || (props.selectedConnectorIds?.length ?? 0) > 0) && <div aria-label="当前任务能力" className="composer-capabilities">
        {tokens.map((token) => { const selected = props.invocations?.find((item) => item.token === token); return <span key={token} className="composer-capability primary" title={selected?.description || '该能力已不可用，请重新选择'}>{selected?.bundledSkill ? <Sparkles size={13} /> : <Puzzle size={13} />}{selected?.name || token}<button aria-label={`移除能力 ${selected?.name || token}`} disabled={locked} onClick={() => props.onPrompt(joinComposerPrompt(tokens.filter((value) => value !== token), text))} type="button"><X size={12} /></button></span> })}
        {props.selectedKnowledgeBaseRefs.map((id) => <span className="composer-capability" key={id}><BookOpen size={13} />{props.knowledgeBases.find((item) => item.reference === id)?.name || id}<button aria-label={`移除知识库 ${id}`} disabled={locked} onClick={() => props.onRemoveKnowledge(id)} type="button"><X size={12} /></button></span>)}
        {props.selectedConnectorIds?.map((id) => <span className="composer-capability" key={id}><Plug size={13} />{props.composerConnectors?.find((item) => item.id === id)?.name || id}<button aria-label={`移除连接器 ${id}`} disabled={locked} onClick={() => props.onToggleTaskConnector?.(id)} type="button"><X size={12} /></button></span>)}
      </div>}
      <ComposerAttachments attachments={props.pendingAttachments} disabled={locked} onOpen={props.onPreview} onRemove={props.onRemoveAttachment} />
      {props.pastingAttachments && <div className="composer-import-status" role="status"><LoaderCircle size={13} />正在添加附件…</div>}
      {pasteError && <div className="local-file-error" role="alert">{pasteError}</div>}
      {query && <div className="composer-popover composer-suggestions" ref={suggestionsPicker}><small>{query.trigger === '/' ? '调用技能或专家套件' : '引用会话、知识库、连接器或工作目录'}</small><div id={listId} role="listbox" aria-label={query.trigger === '/' ? '技能与专家套件' : '任务上下文'}>{suggestions.map((item, index) => <button aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} id={`${listId}-${index}`} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={item.choose} role="option" type="button"><Sparkles size={15} /><span><strong>{item.name}</strong><small>{item.description}</small></span></button>)}</div>{suggestions.length === 0 && <p className="composer-empty">{query.trigger === '/' ? '暂无匹配能力，可通过「＋」浏览和安装。' : '暂无匹配上下文，可通过「＋」添加或配置。'}</p>}<footer>↑ ↓ 选择 · Enter 确认 · Esc 关闭</footer></div>}
      <textarea aria-label="给小胤发送消息" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-expanded={Boolean(query)} aria-controls={query ? listId : undefined} aria-activedescendant={suggestions.length ? `${listId}-${activeIndex}` : undefined}
        onChange={(event) => { props.onPrompt(joinComposerPrompt(tokens, event.target.value)); setCaret(event.target.selectionStart); setOptionIndex(0); setDismissed('') }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)} onKeyDown={inputKey}
        readOnly={checkingClipboard}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (!props.onPasteFiles) return
          if (locked) { if (files.length) { event.preventDefault(); setPasteError('请等待当前处理完成后，再粘贴附件。') } return }
          event.preventDefault()
          const input = event.currentTarget, start = input.selectionStart, end = input.selectionEnd
          const pastedText = event.clipboardData.getData('text/plain')
          const snapshot = pasteView.current, request = ++pasteRequest.current
          setCheckingClipboard(true); setPasteError('')
          void props.onPasteFiles(files).then((handled) => {
            if (handled || request !== pasteRequest.current || snapshot.prompt !== pasteView.current.prompt || snapshot.taskId !== pasteView.current.taskId) return
            if (pastedText) { props.onPrompt(joinComposerPrompt(tokens, text.slice(0, start) + pastedText + text.slice(end))); setCaret(start + pastedText.length); focusInput(start + pastedText.length) }
          }).catch((reason) => { if (request === pasteRequest.current) setPasteError(reason instanceof Error ? reason.message : String(reason)) })
            .finally(() => { if (request === pasteRequest.current) setCheckingClipboard(false) })
        }}
        placeholder={running ? '补充当前任务，Enter 发送' : props.queue?.items.length && !props.queue.paused ? '追加要求，按 Enter 加入队列' : capabilityHint || '描述任务，/ 调用技能或套件，@ 添加上下文'} ref={props.composerRef} value={text} />
      <div className="composer-actions">
        <div className="context-picker" ref={contextPicker}>
          <button aria-expanded={menu === 'context'} aria-haspopup="dialog" aria-label="添加上下文" className="workspace-button context-add-button" disabled={locked} onClick={() => { setDismissed(queryKey); setMenu(menu === 'context' ? undefined : 'context'); setSearch('') }} ref={addButton} title="添加文件、专家套件、技能、连接器或知识库" type="button"><Plus size={18} /></button>
          {menu === 'context' && <section className="composer-popover composer-context-menu composer-cascade" role="dialog" aria-label="添加能力与上下文">
            <div className="composer-cascade-rail"><div className="composer-category-tabs" role="tablist" aria-label="能力分类" aria-orientation="vertical" onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
              const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length
              setCategory(categories[next].id); setSearch(''); tabs[next]?.focus()
            }}>{categories.map(({ id, label, icon: Icon }) => <button aria-selected={category === id} tabIndex={category === id ? 0 : -1} key={id} onMouseEnter={() => { setCategory(id); setSearch('') }} onClick={() => { setCategory(id); setSearch('') }} onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); menuSearch.current?.focus() } }} role="tab" type="button"><Icon size={13} /><span>{label}</span><ChevronDown size={12} /></button>)}</div>
            <button className="composer-add-file" onClick={() => { closeMenu(); props.onAddLocalFiles() }} type="button"><FilePlus2 size={14} /><span>添加文件</span></button></div>
            <div className="composer-cascade-panel" onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' && (!(event.target instanceof HTMLInputElement) || event.target.selectionStart === 0 && event.target.selectionEnd === 0)) {
                event.preventDefault(); root.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
              }
            }}>
            <label className="composer-context-search"><Search size={14} /><input aria-label="搜索能力与上下文" placeholder={`搜索${categories.find((item) => item.id === category)?.label}`} ref={menuSearch} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <div className="composer-option-list" role="tabpanel" aria-label={categories.find((item) => item.id === category)?.label}>
              {menuOptions.map((item) => <button aria-pressed={Boolean(item.selected)} disabled={item.disabled} key={item.id} onClick={item.choose} type="button"><span><strong>{item.name}</strong><small>{item.description}</small></span>{item.selected && <Check size={14} />}</button>)}
              {menuOptions.length === 0 && <p className="composer-empty">{search ? '没有匹配项，试试其他关键词。' : '还没有可用内容，先去添加，回来即可使用。'}</p>}
            </div>
            <footer><span>{category === 'connector' ? props.selectedConnectorIds?.length ? '本轮仅使用所选连接器' : '不指定时按需使用已启用连接器' : '无需先选择能力，也可以直接开始任务'}</span>{props.onBrowseCapability && <button onClick={() => { closeMenu(); props.onBrowseCapability?.(category) }} type="button">管理{categories.find((item) => item.id === category)?.label} →</button>}</footer>
            </div>
          </section>}
        </div>
        <ComposerModelPicker {...props} locked={Boolean(locked)} />
        {running ? <>{text.trim() && <button aria-label="补充到当前任务" className="queue-send-button" type="submit">补充<ArrowUp size={14} /></button>}<button aria-label={stopping ? '正在停止' : '停止本轮'} className="cancel-button" disabled={stopping} onClick={props.onCancel} title="停止本轮，保留对话并暂停队列" type="button"><Square size={11} fill="currentColor" strokeWidth={0} /></button></>
          : <button aria-label={props.queue?.items.length && !props.queue.paused ? '加入消息队列' : '发送'} className="send-button" disabled={(!text.trim() && !tokens.length && props.pendingAttachments.length === 0) || props.runtimeStatus !== 'ready' || props.harnessHealth === 'degraded' || props.taskContextRestoring || props.pastingAttachments || checkingClipboard} title={props.runtimeStatus !== 'ready' ? '企业服务未连接' : props.harnessHealth === 'degraded' ? '请先恢复本地 Agent' : props.taskContextRestoring ? '正在恢复任务上下文' : '发送'} type="submit"><ArrowUp size={17} /></button>}
      </div>
    </form>
    {props.localFileError && <div className="local-file-error" role="alert">{props.localFileError}</div>}
    <div className="context-bar">
      <div className="composer-directory-picker" ref={directoryPicker} onMouseLeave={() => setRecentOpen(false)}><button aria-expanded={menu === 'directory'} aria-haspopup="menu" className="context-directory-button" disabled={locked} onClick={() => { setMenu(menu === 'directory' ? undefined : 'directory'); setRecentOpen(false); setDismissed(queryKey) }} ref={directoryButton} type="button"><FolderPlus size={14} />{props.localDirectories.length ? props.localDirectories[0].name : '选择工作目录'}{props.localDirectories.length > 1 && ` +${props.localDirectories.length - 1}`}<ChevronDown size={13} /></button>
        {menu === 'directory' && <div aria-label="工作目录" className={`composer-popover composer-directory-menu${directoryAbove ? ' above' : ''}${directoryAlignEnd ? ' align-end' : ''}`} ref={directoryMenu} role="menu"><button className="composer-directory-action" onMouseEnter={() => setRecentOpen(false)} onFocus={() => setRecentOpen(false)} onClick={() => { closeMenu(); props.onAddLocalDirectory() }} role="menuitem" type="button"><FolderPlus size={17} />选择目录</button>
          <button aria-controls={recentOpen ? recentMenuId : undefined} aria-expanded={recentOpen} aria-haspopup="menu" className={`composer-directory-action${recentOpen ? ' active' : ''}`} onMouseEnter={() => setRecentOpen(true)} onClick={() => setRecentOpen(true)} onKeyDown={(event) => {
            if (event.key !== 'ArrowRight') return
            event.preventDefault(); setRecentOpen(true)
            window.requestAnimationFrame(() => recentMenu.current?.querySelector<HTMLButtonElement>('button')?.focus())
          }} ref={recentButton} role="menuitem" type="button"><History size={17} />最近使用的目录<ChevronRight className="composer-directory-chevron" size={17} /></button>
          {recentOpen && <div aria-label="最近使用的目录" className={`composer-directory-recent${recentToLeft ? ' to-left' : ''}`} id={recentMenuId} onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); setRecentOpen(false); recentButton.current?.focus() }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
          }} ref={recentMenu} role="menu">{availableRecentDirectories.length
            ? availableRecentDirectories.map((item) => {
              const selected = props.localDirectories.find((current) => current.id === item.id || Boolean(item.path && current.path === item.path))
              return <button aria-current={selected ? 'true' : undefined} key={item.path || item.id} onClick={() => { closeMenu(); if (selected) props.onRemoveLocalDirectory(selected.id); else if (item.path) props.onSelectRecentDirectory?.(item.path) }} role="menuitem" title={item.path} type="button"><span>{recentDirectoryLabel(item.path || item.name)}</span>{selected && <Check size={14} />}</button>
            })
            : <p className="composer-directory-empty">暂无可用的最近目录</p>}</div>}
        </div>}
      </div>
      {blockedReason
        ? <small className="composer-blocked" role="status">{blockedReason}</small>
        : <small className="composer-hint">Enter {running ? '插入当前任务' : props.queue?.items.length && !props.queue.paused ? '加入队列' : '发送'} · Shift+Enter 换行</small>}
    </div>
  </div>
}
