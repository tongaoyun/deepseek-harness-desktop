/** Explicit team membership managed with native dialogs and the existing library transport. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibrarySchema, LibraryMemberPageSchema, LibraryCandidateSchema, LibraryCandidatePageSchema, type Library, type LibraryMember } from '@deepseek-harness/product/library'
import { z } from 'zod'
import type { LibraryText } from './LibraryBrowser.tsx'
import { useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/**
 * @param props Current team, localized labels and confirmed membership-change callback.
 * @returns One native modal for browsing, adding, changing or transferring team access.
 */
export function LibraryMembers({ library, t, onClose, onChanged }: {
  readonly library: Library
  readonly t: LibraryText
  readonly onClose: () => void
  readonly onChanged: (library: Library) => void
}): ReactNode {
  const request = useLibraryRequests()
  const [current, setCurrent] = useState(library)
  const [mode, setMode] = useState<'members' | 'invite' | 'transfer'>('members')
  const [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const [members, setMembers] = useState<z.infer<typeof LibraryMemberPageSchema>>()
  const [revision, setRevision] = useState(0), [pending, setPending] = useState(true)
  const [readError, setReadError] = useState<unknown>(), [writeError, setWriteError] = useState<unknown>()
  const [type, setType] = useState<LibraryMember['subjectType']>('EMPLOYEE')
  const [candidates, setCandidates] = useState<readonly z.infer<typeof LibraryCandidateSchema>[]>([])
  const [candidatePages, setCandidatePages] = useState(0), [candidatePage, setCandidatePage] = useState(1)
  const [candidateQuery, setCandidateQuery] = useState(''), [subject, setSubject] = useState('')
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER')
  const [busy, setBusy] = useState(false)
  const writing = useRef<AbortController>()
  const reading = useRef<AbortController>()
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLElement | null>(null)
  const captureResult = useResultFocus(area, search)
  const capture = useCallback(() => { area.current = root.current?.closest<HTMLElement>('[role="dialog"]') ?? null; captureResult() }, [captureResult])
  const owner = current.role === 'OWNER'
  useEffect(() => () => { writing.current?.abort() }, [])
  useEffect(() => {
    const controller = new AbortController()
    reading.current = controller; setPending(true)
    const read = async () => {
      const meta = LibrarySchema.parse(await request('library.get', { libraryId: library.id }, controller.signal))
      controller.signal.throwIfAborted()
      capture(); setCurrent(meta)
      if (meta.role !== 'OWNER' && mode !== 'members') { setMode('members'); return }
      if (mode === 'members') {
        const value = await request('library.members.list', { libraryId: library.id, query, page, size: 20 }, controller.signal)
        controller.signal.throwIfAborted()
        const result = LibraryMemberPageSchema.parse(value)
        if (page > Math.max(1, result.totalPages)) { setPage(Math.max(1, result.totalPages)); return }
        capture(); setMembers(result)
      } else if (type !== 'COMPANY' || mode === 'transfer') {
        const value = await request(type === 'DEPARTMENT' && mode !== 'transfer'
          ? 'library.memberOptions.departments' : 'library.memberOptions.employees',
        type === 'DEPARTMENT' && mode !== 'transfer' ? {} : { query: candidateQuery, page: candidatePage, size: 20 }, controller.signal)
        controller.signal.throwIfAborted()
        const result = type === 'DEPARTMENT' && mode !== 'transfer' ? { data: z.array(LibraryCandidateSchema).parse(value), totalPages: 1 }
          : LibraryCandidatePageSchema.parse(value)
        if (candidatePage > Math.max(1, result.totalPages)) { setCandidatePage(Math.max(1, result.totalPages)); return }
        capture(); setCandidates(result.data); setCandidatePages(result.totalPages)
      }
      controller.signal.throwIfAborted()
      capture(); setReadError(undefined)
    }
    void read().catch((error: unknown) => { if (!controller.signal.aborted) setReadError(error) })
      .finally(() => { if (reading.current === controller) reading.current = undefined; if (!controller.signal.aborted) setPending(false) })
    return () => { controller.abort(); if (reading.current === controller) reading.current = undefined }
  }, [request, library.id, mode, query, page, revision, type, candidateQuery, candidatePage, capture])
  const changeMode = (next: typeof mode) => {
    if (writing.current) return
    capture(); setPending(true); setMode(next); setSubject(''); setType('EMPLOYEE'); setCandidates([])
    setCandidateQuery(''); setCandidatePage(1); setReadError(undefined); setWriteError(undefined)
  }
  const write = async (method: string, payload: Readonly<Record<string, unknown>>) => {
    if (writing.current || reading.current || pending || readError !== undefined || !owner) return
    const controller = new AbortController(); writing.current = controller; setBusy(true)
    try {
      const next = LibrarySchema.parse(await request(method, {
        libraryId: current.id, version: current.version, ...payload,
      }, controller.signal))
      controller.signal.throwIfAborted()
      capture(); setCurrent(next); setWriteError(undefined); setMode('members'); setRevision(value => value + 1)
      onChanged(next)
    } catch (error) { if (!controller.signal.aborted) setWriteError(error) }
    finally { if (writing.current === controller) { writing.current = undefined; if (!controller.signal.aborted) setBusy(false) } }
  }
  const roleLabel = (value: LibraryMember['role']) =>
    t(value === 'OWNER' ? 'libraryOwner' : value === 'EDITOR' ? 'libraryEditor' : 'libraryViewer')
  return <Modal open title={mode === 'transfer' ? t('libraryTransfer') : t('libraryMembers')} closeLabel={t('close')}
    onClose={() => { if (!writing.current) onClose() }} className={`${css.detailModal} ${css.libraryMembersModal}`} contentClassName={css.detailModalContent as string}
    footer={<div className={css.libraryMutationFooter}>
      <div className={css.libraryErrorStack}>
        <div className={css.feedbackResult}><span aria-hidden="true">{t('libraryLoadFailed')}</span>
          {readError !== undefined && <p role="alert" className={css.catalogError}>{productErrorMessage(readError, t, 'libraryLoadFailed')}</p>}
        </div>
        <div className={css.feedbackResult}><span aria-hidden="true">{t('saveFailed')}</span>
          {writeError !== undefined && <p role="alert" className={css.catalogError}>{productErrorMessage(writeError, t, 'saveFailed')}</p>}
        </div>
        {(readError !== undefined || writeError !== undefined) && <Button variant="ghost" aria-disabled={pending || busy} onClick={() => {
          if (!reading.current && !writing.current) setRevision(value => value + 1)
        }}>{t('retry')}</Button>}
      </div>
      <div className={css.detailActions}>
        <Button variant="outline" aria-disabled={busy} onClick={() => { if (!writing.current) { if (mode === 'members') onClose(); else changeMode('members') } }}>{t(mode === 'members' ? 'close' : 'cancel')}</Button>
        {mode !== 'members' && owner && <Button variant="primary" aria-disabled={busy || pending || readError !== undefined || !(type === 'COMPANY' ? current.companyId : subject)} aria-busy={busy} onClick={() => {
          const id = type === 'COMPANY' && mode !== 'transfer' ? current.companyId : subject
          if (!pending && readError === undefined && id) void write(mode === 'transfer' ? 'library.owner.transfer' : 'library.members.save',
            mode === 'transfer' ? { employeeId: id } : { subjectType: type, subjectId: id, role })
        }}>{t(mode === 'transfer' ? 'libraryTransfer' : 'libraryInvite')}</Button>}
      </div>
    </div>}>
    <div ref={root}>
      <div className={css.libraryMemberToolbar}>
        <Input ref={search} type="search" aria-label={t('libraryMemberSearch')} placeholder={t('libraryMemberSearch')}
          value={mode === 'members' ? query : candidateQuery} readOnly={busy}
          onChange={(event) => { if (!writing.current) {
            setPending(true)
            if (mode === 'members') { setQuery(event.target.value); setPage(1) }
            else { setCandidateQuery(event.target.value); setCandidatePage(1) }
          } }} />
        {mode === 'members' && owner && <Button variant="outline" aria-disabled={busy} onClick={() => { changeMode('invite') }}>{t('libraryInvite')}</Button>}
      </div>
      <div hidden={mode !== 'members'}>
        <ul className={css.libraryMembers}>{members?.data.map(member => <li key={`${member.subjectType}:${member.subjectId}`}>
          <div><span>{member.name}</span><small>{t(member.subjectType === 'EMPLOYEE' ? 'libraryEmployee' : member.subjectType === 'DEPARTMENT' ? 'libraryDepartment' : 'libraryCompany')}</small></div>
          {owner && member.role !== 'OWNER' ? <>
            <label className={css.libraryField}><select aria-label={`${t('libraryMemberRole')}: ${member.name}`} aria-disabled={busy || pending} value={member.role} onChange={(event) => {
              if (!writing.current && !reading.current) void write('library.members.save', { subjectType: member.subjectType, subjectId: member.subjectId, role: event.target.value })
            }}><option value="VIEWER">{t('libraryViewer')}</option><option value="EDITOR">{t('libraryEditor')}</option></select>
            </label>
            <Button variant="ghost" size="sm" aria-label={`${t('libraryMemberRemove')}: ${member.name}`} aria-disabled={busy || pending} onClick={() => {
              void write('library.members.remove', { subjectType: member.subjectType, subjectId: member.subjectId })
            }}>{t('libraryMemberRemove')}</Button>
          </> : <span>{roleLabel(member.role)}</span>}
        </li>)}</ul>
        {members?.data.length === 0 && <p>{t('libraryMembersEmpty')}</p>}
        <div className={css.libraryPagination} hidden={page <= 1 && (members?.totalPages ?? 0) <= 1}>
          <Button variant="ghost" aria-disabled={pending || busy || page <= 1} onClick={() => { if (!reading.current && !writing.current && page > 1) setPage(page - 1) }}>{t('libraryPrevious')}</Button>
          <span>{page} / {Math.max(1, members?.totalPages ?? 0)}</span>
          <Button variant="ghost" aria-disabled={pending || busy || page >= (members?.totalPages ?? 0)} onClick={() => { if (!reading.current && !writing.current && page < (members?.totalPages ?? 0)) setPage(page + 1) }}>{t('libraryNext')}</Button>
        </div>
        {owner && <Button variant="ghost" aria-disabled={busy} onClick={() => { changeMode('transfer') }}>{t('libraryTransfer')}</Button>}
      </div>
      {mode !== 'members' && owner && <div>
        {mode === 'transfer' ? <p>{t('libraryTransferHint')}</p> : <label className={css.libraryField}>{t('librarySubjectType')}
          <select value={type} onChange={(event) => {
            if (writing.current) return
            setPending(true); setType(event.target.value as LibraryMember['subjectType']); setSubject(''); setCandidates([]); setCandidateQuery(''); setCandidatePage(1)
          }}><option value="EMPLOYEE">{t('libraryEmployee')}</option><option value="DEPARTMENT">{t('libraryDepartment')}</option><option value="COMPANY">{t('libraryCompany')}</option></select>
        </label>}
        {type !== 'COMPANY' && <>
          <label className={css.libraryField}>{t('libraryChooseMember')}<select value={subject} onChange={(event) => { if (!writing.current) setSubject(event.target.value) }}>
            <option value="">{t('libraryChooseMember')}</option>
            {subject && !candidates.some(item => item.id === subject) && <option value={subject}>{subject}</option>}
            {candidates.filter(item => type !== 'EMPLOYEE' || item.id !== current.ownerId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <div className={css.libraryPagination} hidden={candidatePage <= 1 && candidatePages <= 1}>
            <Button variant="ghost" aria-disabled={pending || busy || candidatePage <= 1} onClick={() => { if (!reading.current && !writing.current && candidatePage > 1) setCandidatePage(candidatePage - 1) }}>{t('libraryPrevious')}</Button>
            <span>{candidatePage} / {Math.max(1, candidatePages)}</span>
            <Button variant="ghost" aria-disabled={pending || busy || candidatePage >= candidatePages} onClick={() => { if (!reading.current && !writing.current && candidatePage < candidatePages) setCandidatePage(candidatePage + 1) }}>{t('libraryNext')}</Button>
          </div>
        </>}
        {mode !== 'transfer' && <label className={css.libraryField}>{t('libraryMemberRole')}<select value={role} onChange={(event) => { if (!writing.current) setRole(event.target.value as typeof role) }}>
          <option value="VIEWER">{t('libraryViewer')}</option><option value="EDITOR">{t('libraryEditor')}</option></select></label>}
      </div>}
    </div>
  </Modal>
}
