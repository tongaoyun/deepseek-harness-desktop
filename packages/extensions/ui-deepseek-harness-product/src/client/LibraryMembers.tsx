/** Explicit team membership managed with native dialogs and the existing library transport. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconSearchOutlineRegular, IconUserOutlineRegular, IconUsersOutlineRegular, Input, Menu, Modal, SegmentedControl, Tooltip, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibrarySchema, LibraryMemberPageSchema, LibraryCandidateSchema, LibraryCandidatePageSchema, type Library, type LibraryMember } from '@deepseek-harness/product/library'
import { z } from 'zod'
import { productFailure } from '@deepseek-harness/product/errors'
import type { LibraryText } from './LibraryBrowser.tsx'
import { useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'

type MemberAction = { readonly kind: 'invite' | 'transfer' }
  | { readonly kind: 'access' | 'remove'; readonly subjectType: LibraryMember['subjectType']; readonly subjectId: string }

/** Native access menu closes unchanged choices without submitting or refreshing. */
function MemberAccess({ value, label, locked, pending = false, t, onChange }: {
  readonly value: 'EDITOR' | 'VIEWER'
  readonly label: string
  readonly locked: boolean
  readonly pending?: boolean
  readonly t: LibraryText
  readonly onChange: (value: 'EDITOR' | 'VIEWER') => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu portal align="end" open={open} onClose={() => { setOpen(false) }} selectedId={value}
    items={[{ id: 'VIEWER', label: t('libraryViewer') }, { id: 'EDITOR', label: t('libraryEditor') }]}
    onSelect={(id) => {
      if (locked || (id !== 'VIEWER' && id !== 'EDITOR')) return
      setOpen(false)
      if (id !== value) onChange(id)
    }} anchor={<Button variant="ghost" size="sm" aria-label={label} aria-description={t(value === 'EDITOR' ? 'libraryEditor' : 'libraryViewer')} aria-haspopup="menu" aria-expanded={open}
      aria-disabled={locked} aria-busy={pending} onClick={() => { if (!locked) setOpen(!open) }}>
      {t(value === 'EDITOR' ? 'libraryEditor' : 'libraryViewer')}<IconChevronDownOutlineRegular size={14} />
    </Button>} />
}

/**
 * @param props Current team, localized labels, version reconciliation, confirmed writes and close action.
 * @returns One native modal for team access; removed action focus returns to search or the visible subject tab.
 */
export function LibraryMembers({ library, t, onClose, onChanged, onConfirmed }: {
  readonly library: Library
  readonly t: LibraryText
  readonly onClose: () => void
  readonly onChanged: (library: Library) => void
  readonly onConfirmed?: (library: Library) => Library
}): ReactNode {
  const request = useLibraryRequests()
  const subjectsId = useId()
  const [current, setCurrent] = useState(library)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<'members' | 'transfer'>('members')
  const [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const [members, setMembers] = useState<z.infer<typeof LibraryMemberPageSchema>>()
  const [revision, setRevision] = useState(0), [pending, setPending] = useState(true)
  const [readError, setReadError] = useState<unknown>(), [writeError, setWriteError] = useState<unknown>()
  const conflict = writeError !== undefined && productFailure(writeError).code === 'LIBRARY_CONFLICT'
  const [type, setType] = useState<LibraryMember['subjectType']>('EMPLOYEE')
  const [candidates, setCandidates] = useState<readonly z.infer<typeof LibraryCandidateSchema>[]>()
  const [candidatePages, setCandidatePages] = useState(0), [candidatePage, setCandidatePage] = useState(1)
  const [selected, setSelected] = useState<z.infer<typeof LibraryCandidateSchema>>()
  const subject = selected?.id ?? ''
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER')
  const [mutation, setMutation] = useState<MemberAction>()
  const busy = mutation !== undefined
  const writing = useRef<AbortController>()
  const reading = useRef<AbortController>()
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLElement | null>(null)
  const captureResult = useResultFocus(area, () => {
    const input = search.current
    const target = input && !input.closest('[hidden]') ? input
      : root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  const capture = useCallback(() => { area.current = root.current?.closest<HTMLElement>('[role="dialog"]') ?? null; captureResult() }, [captureResult])
  const owner = current.role === 'OWNER'
  useEffect(() => () => { writing.current?.abort() }, [])
  useEffect(() => {
    const controller = new AbortController()
    reading.current = controller; setPending(true)
    const read = async () => {
      const received = LibrarySchema.parse(await request('library.get', { libraryId: library.id }, controller.signal))
      controller.signal.throwIfAborted()
      const meta = onConfirmed ? onConfirmed(received) : received
      capture(); setCurrent(meta)
      if (meta.role !== 'OWNER' && mode !== 'members') { setMode('members'); return }
      if (mode === 'members') {
        const value = await request('library.members.list', {
          libraryId: library.id, query: meta.role === 'OWNER' ? '' : query, page, size: 20,
        }, controller.signal)
        controller.signal.throwIfAborted()
        const result = LibraryMemberPageSchema.parse(value)
        if (page > Math.max(1, result.totalPages)) { setPage(Math.max(1, result.totalPages)); return }
        capture(); setMembers(result)
      }
      if (meta.role === 'OWNER' && (type !== 'COMPANY' || mode === 'transfer')) {
        const value = await request(type === 'DEPARTMENT' && mode !== 'transfer'
          ? 'library.memberOptions.departments' : 'library.memberOptions.employees',
        type === 'DEPARTMENT' && mode !== 'transfer' ? {} : { query, page: candidatePage, size: 20 }, controller.signal)
        controller.signal.throwIfAborted()
        const result = type === 'DEPARTMENT' && mode !== 'transfer' ? { data: z.array(LibraryCandidateSchema).parse(value), totalPages: 1 }
          : LibraryCandidatePageSchema.parse(value)
        if (candidatePage > Math.max(1, result.totalPages)) { setCandidatePage(Math.max(1, result.totalPages)); return }
        capture(); setCandidates(result.data); setCandidatePages(result.totalPages)
      }
      controller.signal.throwIfAborted()
      capture(); setReadError(undefined); setWriteError(undefined)
    }
    void read().catch((error: unknown) => { if (!controller.signal.aborted) setReadError(error) })
      .finally(() => { if (reading.current === controller) reading.current = undefined; if (!controller.signal.aborted) setPending(false) })
    return () => { controller.abort(); if (reading.current === controller) reading.current = undefined }
  }, [request, library.id, mode, query, page, revision, type, candidatePage, capture, onConfirmed])
  const changeMode = (next: typeof mode) => {
    if (writing.current) return
    capture(); setPending(true); setMode(next); setSelected(undefined); setType('EMPLOYEE'); setCandidates(undefined); setCandidatePages(0)
    setQuery(''); setCandidatePage(1); setReadError(undefined); setWriteError(undefined)
  }
  const write = async (method: string, payload: Readonly<Record<string, unknown>>, action: MemberAction) => {
    if (writing.current || reading.current || pending || readError !== undefined || conflict || !owner) return
    const controller = new AbortController(); writing.current = controller; setMutation(action)
    try {
      const next = LibrarySchema.parse(await request(method, {
        libraryId: current.id, version: current.version, ...payload,
      }, controller.signal))
      controller.signal.throwIfAborted()
      capture(); setCurrent(next); setWriteError(undefined); setPending(true); setMode('members'); setRevision(value => value + 1)
      if (payload.subjectId === selected?.id) setSelected(undefined)
      onChanged(next)
    } catch (error) { if (!controller.signal.aborted) setWriteError(error) }
    finally { if (writing.current === controller) { writing.current = undefined; if (!controller.signal.aborted) setMutation(undefined) } }
  }
  const roleLabel = (value: LibraryMember['role']) =>
    t(value === 'OWNER' ? 'libraryOwner' : value === 'EDITOR' ? 'libraryEditor' : 'libraryViewer')
  const candidateItems = candidates?.filter(item => type !== 'EMPLOYEE' || item.id !== current.ownerId)
  return <Modal open title={t(mode === 'transfer' ? 'libraryTransfer' : 'libraryMembers')} closeLabel={t('close')}
    onClose={() => { if (!writing.current) onClose() }} className={`${css.libraryModal} ${css.libraryMembersModal}`}
    contentClassName={css.detailModalContent as string}
    footer={<>
      <Button variant="outline" aria-disabled={busy} onClick={() => {
        if (!writing.current) { if (mode === 'transfer') changeMode('members'); else onClose() }
      }}>{t(mode === 'members' ? 'close' : 'cancel')}</Button>
      {mode === 'transfer' && owner && <Button variant="primary"
        aria-disabled={busy || pending || readError !== undefined || conflict || !subject} aria-busy={mutation?.kind === 'transfer'}
        onClick={() => { if (subject) void write('library.owner.transfer', { employeeId: subject }, { kind: 'transfer' }) }}>
        {t('libraryTransfer')}</Button>}
    </>}>
    <div ref={root} className={css.libraryMemberBody}>
      <div className={css.libraryMemberIntro}>
        <div className={css.libraryMemberContext}>
          <IconUsersOutlineRegular size={16} /><span>{current.name}</span>
          {mode === 'members' && owner && <Menu portal align="end" open={moreOpen} onClose={() => { setMoreOpen(false) }}
            items={[{ id: 'transfer', label: t('libraryTransfer') }]}
            onSelect={() => {
              if (moreTrigger.current) focusWithoutRing(moreTrigger.current)
              setMoreOpen(false); changeMode('transfer')
            }} anchor={<Tooltip portal label={t('libraryTeamActions')}><Button ref={moreTrigger} variant="ghost" size="sm" aria-label={t('libraryTeamActions')}
              aria-haspopup="menu" aria-expanded={moreOpen} aria-disabled={busy}
              onClick={() => { if (!writing.current) setMoreOpen(value => !value) }}>
              <IconEllipsisOutlineRegular size={16} /></Button></Tooltip>} />}
        </div>
        <p className={css.libraryMemberHint}>{t(mode === 'transfer' ? 'libraryTransferHint' : 'libraryMemberAccessHint')}</p>
      </div>
      {mode === 'members' && owner && <div className={css.libraryMemberSubjects} aria-disabled={busy}>
        <SegmentedControl id={subjectsId} label={t('librarySubjectType')} value={type} options={[
          { value: 'EMPLOYEE', label: t('libraryEmployee') }, { value: 'DEPARTMENT', label: t('libraryDepartment') },
          { value: 'COMPANY', label: t('libraryCompany') },
        ]} onChange={(value) => {
          if (writing.current || value === type) return
          capture(); setPending(true); setType(value); setSelected(undefined); setCandidates(undefined); setCandidatePages(0)
          setQuery(''); setCandidatePage(1); setReadError(undefined)
        }} />
      </div>}
      <div className={css.libraryMemberToolbar} hidden={type !== 'EMPLOYEE' && owner}>
        <Input ref={search} data-modal-autofocus type="search" maxLength={180} icon={<IconSearchOutlineRegular size={16} />}
          aria-label={t('libraryMemberSearch')} placeholder={t('libraryMemberSearch')}
          value={query} readOnly={busy}
          onChange={(event) => { if (!writing.current) {
            setPending(true)
            setQuery(event.target.value)
            if (!owner && mode === 'members') setPage(1)
            else setCandidatePage(1)
          } }} />
      </div>
      {owner && <div className={css.libraryMemberSelection}
        {...(mode === 'members' ? { id: `${subjectsId}-${type}-panel`, role: 'tabpanel', 'aria-labelledby': `${subjectsId}-${type}` } : {})}>
        {type !== 'COMPANY' && <>
          <div role="group" aria-label={t('libraryChooseMember')} aria-busy={pending} className={css.libraryMemberCandidates}>
            {candidates === undefined && pending && <div role="status" aria-label={t('loading')} className={css.libraryMemberSkeleton}>
              <span /><span /><span /><span />
            </div>}
            {candidateItems?.map(item => <Button key={item.id} variant="ghost" aria-pressed={subject === item.id}
              aria-disabled={busy || pending || readError !== undefined} onClick={() => {
                if (!writing.current && !reading.current && !pending && readError === undefined) setSelected(item)
              }}>
              {type === 'EMPLOYEE' ? <IconUserOutlineRegular size={16} /> : <IconUsersOutlineRegular size={16} />}
              <span>{item.name}</span><IconCheckOutlineRegular size={16} aria-hidden="true" />
            </Button>)}
            {!pending && readError === undefined && candidateItems?.length === 0 && <p>{t('libraryCandidatesEmpty')}</p>}
          </div>
          <div className={css.libraryMemberPagination} hidden={candidatePage <= 1 && candidatePages <= 1}>
            <Button variant="ghost" size="sm" aria-disabled={pending || busy || candidatePage <= 1} onClick={() => { if (!reading.current && !writing.current && candidatePage > 1) setCandidatePage(candidatePage - 1) }}>{t('libraryPrevious')}</Button>
            <span>{candidatePage} / {Math.max(1, candidatePages)}</span>
            <Button variant="ghost" size="sm" aria-disabled={pending || busy || candidatePage >= candidatePages} onClick={() => { if (!reading.current && !writing.current && candidatePage < candidatePages) setCandidatePage(candidatePage + 1) }}>{t('libraryNext')}</Button>
          </div>
          <p className={css.libraryMemberSelected} aria-live="polite">{selected ? t('librarySelectedMember').replace('{name}', selected.name) : t('libraryChooseMember')}</p>
        </>}
        {mode !== 'transfer' && <div className={css.libraryMemberAccess}>
          <span>{t('libraryMemberRole')}</span><MemberAccess value={role} label={t('libraryMemberRole')} locked={busy} t={t} onChange={setRole} />
          <Button variant="primary" size="sm" aria-busy={mutation?.kind === 'invite'}
            aria-disabled={busy || pending || readError !== undefined || conflict || !(type === 'COMPANY' ? current.companyId : subject)}
            onClick={() => {
              const id = type === 'COMPANY' ? current.companyId : subject
              if (id) void write('library.members.save', { subjectType: type, subjectId: id, role }, { kind: 'invite' })
            }}>{t('libraryInvite')}</Button>
        </div>}
      </div>}
      <div hidden={mode !== 'members'}>
        <p className={css.libraryMemberCount}>{t('libraryMemberList')}{members ? ` · ${members.totalCount}` : ''}</p>
        <div className={css.libraryMemberRoster}>
          {members === undefined && pending && <div className={css.libraryMemberPlaceholder} aria-label={t('loading')} role="status" />}
          <ul className={css.libraryMembers}>{members?.data.map(member => <li key={`${member.subjectType}:${member.subjectId}`}>
            <div><span>{member.name}</span><small>{t(member.subjectType === 'EMPLOYEE' ? 'libraryEmployee' : member.subjectType === 'DEPARTMENT' ? 'libraryDepartment' : 'libraryCompany')}</small></div>
            {owner && member.role !== 'OWNER' ? <>
              <MemberAccess value={member.role} label={`${t('libraryMemberRole')}: ${member.name}`} locked={busy || pending || readError !== undefined || conflict} t={t}
                pending={mutation?.kind === 'access' && mutation.subjectType === member.subjectType && mutation.subjectId === member.subjectId}
                onChange={(value) => { void write('library.members.save', { subjectType: member.subjectType, subjectId: member.subjectId, role: value },
                  { kind: 'access', subjectType: member.subjectType, subjectId: member.subjectId }) }} />
              <Button variant="ghost" size="sm" aria-label={`${t('libraryMemberRemove')}: ${member.name}`} aria-disabled={busy || pending || readError !== undefined || conflict}
                aria-busy={mutation?.kind === 'remove' && mutation.subjectType === member.subjectType && mutation.subjectId === member.subjectId} onClick={() => {
                  void write('library.members.remove', { subjectType: member.subjectType, subjectId: member.subjectId },
                    { kind: 'remove', subjectType: member.subjectType, subjectId: member.subjectId })
                }}>{t('libraryMemberRemove')}</Button>
            </> : <span>{roleLabel(member.role)}</span>}
          </li>)}</ul>
          {members?.data.length === 0 && <p>{t('libraryMembersEmpty')}</p>}
        </div>
        <div className={css.libraryMemberPagination} hidden={page <= 1 && (members?.totalPages ?? 0) <= 1}>
          <Button variant="ghost" size="sm" aria-disabled={pending || busy || page <= 1} onClick={() => { if (!reading.current && !writing.current && page > 1) setPage(page - 1) }}>{t('libraryPrevious')}</Button>
          <span>{page} / {Math.max(1, members?.totalPages ?? 0)}</span>
          <Button variant="ghost" size="sm" aria-disabled={pending || busy || page >= (members?.totalPages ?? 0)} onClick={() => { if (!reading.current && !writing.current && page < (members?.totalPages ?? 0)) setPage(page + 1) }}>{t('libraryNext')}</Button>
        </div>
      </div>
      <div className={css.libraryMemberFeedback}>
        {(readError !== undefined || writeError !== undefined) && <p role="alert" tabIndex={0} className={css.catalogError}>
          {productErrorMessage(readError ?? writeError, t, readError !== undefined ? 'libraryLoadFailed' : 'saveFailed')}</p>}
        {(readError !== undefined || writeError !== undefined) && <Button variant="ghost" size="sm" aria-disabled={pending || busy} onClick={() => {
          if (!reading.current && !writing.current) setRevision(value => value + 1)
        }}>{t('retry')}</Button>}
      </div>
    </div>
  </Modal>
}
