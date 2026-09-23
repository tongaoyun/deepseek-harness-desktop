import { ChevronDown, ExternalLink, Files, FolderSearch, Undo2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { revealLocalArtifact, undoLocalFileChange, undoUnavailableReason, type LocalArtifactTarget, type UndoFileResult } from './localArtifactPreview'
import { useDialogFocus } from './useDialogFocus'
import type { TaskFileChange } from './types'

const PREVIEW_COUNT = 3

export function FileChangesCard({ changes, onOpen, onReview, onUndone, busy = false }: {
  changes: TaskFileChange[]
  onOpen?: (target: LocalArtifactTarget) => void
  onReview?: (targets: LocalArtifactTarget[]) => void
  onUndone?: (results: UndoFileResult[]) => void
  busy?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [results, setResults] = useState<UndoFileResult[]>([])
  const undoLock = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)
  useDialogFocus(dialog, confirming ? 'undo' : '', () => { if (!undoLock.current) setConfirming(false) })
  if (changes.length === 0) return null
  const current = changes.map((change) => ({ ...change, ...results.find((item) => item.id === change.id) }))
  const visible = expanded ? current : current.slice(0, PREVIEW_COUNT)
  const eligible = current.filter((change) => !undoUnavailableReason(change))
  const reviewable = current.filter((change) => !change.undoneAt && (change.action !== 'deleted' || change.backupPath))
  const allUndone = current.every((change) => change.undoneAt)
  const completeCounts = current.every((change) => change.addedLines !== undefined && change.deletedLines !== undefined)
  const totals = current.reduce((value, change) => ({ added: value.added + (change.addedLines ?? 0), deleted: value.deleted + (change.deletedLines ?? 0) }), { added: 0, deleted: 0 })
  const undo = async () => {
    if (undoLock.current || busy) return
    undoLock.current = true
    setUndoing(true)
    setError('')
    const completed: UndoFileResult[] = []
    const errors: string[] = []
    for (const change of eligible) {
      try {
        const result = await undoLocalFileChange(change)
        completed.push(result)
        setResults((value) => [...value, result])
      } catch (reason) { errors.push(`${change.path}：${reason instanceof Error ? reason.message : String(reason)}`) }
    }
    // Keep successful results even if another file conflicts; never claim all-or-nothing.
    if (completed.length) onUndone?.(completed)
    setError(errors.join('\n'))
    setConfirming(false)
    setUndoing(false)
    undoLock.current = false
  }

  return <section aria-label="文件改动" className="file-changes-card">
    <header className="file-changes-summary">
      <span className="file-changes-icon"><Files size={22} /></span>
      <span className="file-changes-heading">
        <strong>{allUndone ? '已撤销' : '已编辑'} {changes.length} 个文件</strong>
        {!allUndone && (completeCounts ? <small><ins>+{totals.added}</ins> <del>-{totals.deleted}</del></small> : <small className="file-counts-hint">审核中查看完整差异</small>)}
      </span>
      <div className="file-changes-controls">
        <button disabled={busy || undoing || eligible.length === 0} onClick={() => setConfirming(true)} title={busy ? '任务执行完成后可以撤销' : eligible.length ? `撤销 ${eligible.length} 个可恢复文件` : allUndone ? '已撤销' : '缺少可验证记录，或改动类型不支持自动撤销'} type="button"><Undo2 size={15} />撤销</button>
        <button disabled={!onReview || !reviewable.length} onClick={() => onReview?.(reviewable.map(target))} type="button">审核</button>
      </div>
    </header>
    <div className="file-changes-expanded">
      <div className="file-change-list">
        {visible.map((change) => <div className={`file-change-row ${change.action}`} key={change.id}>
          <button className="file-change-path" disabled={!onOpen || Boolean(change.undoneAt) || (change.action === 'deleted' && !change.backupPath)} onClick={() => onOpen?.(target(change))} title={`${change.rootName}/${change.path}`} type="button">{change.path}</button>
          <small className="file-change-kind" title={undoUnavailableReason(change)}>{change.undoneAt ? '已撤销' : actionLabel(change.action)}</small>
          <code>{!change.undoneAt && <>{change.addedLines !== undefined && <ins>+{change.addedLines}</ins>}{change.deletedLines !== undefined && <del>-{change.deletedLines}</del>}</>}</code>
          <span className="file-change-actions">
            <button aria-label={`打开 ${change.name}`} disabled={!onOpen || Boolean(change.undoneAt) || (change.action === 'deleted' && !change.backupPath)} onClick={() => onOpen?.(target(change))} title="在小胤中审查" type="button"><ExternalLink size={14} /></button>
            <button aria-label={`在文件夹中显示 ${change.name}`} disabled={change.action === 'deleted' && !change.recoveryPath} onClick={() => {
              setError('')
              void revealLocalArtifact({ ...target(change), path: change.recoveryPath ?? change.path }).catch((reason) => setError(String(reason)))
            }} title={change.recoveryPath ? '定位撤销前的恢复副本' : '在文件夹中显示'} type="button"><FolderSearch size={14} /></button>
          </span>
        </div>)}
      </div>
      {error && <p className="file-changes-error" role="alert">{error}</p>}
      {current.some((change) => change.undoneAt) && <p className="file-changes-note" role="status">已撤销 {current.filter((change) => change.undoneAt).length} 个文件；撤销前的版本已保存在 .xiaoyin-backups/undo，点击文件夹图标可定位。</p>}
      {changes.length > PREVIEW_COUNT && <button aria-expanded={expanded} className="file-changes-more" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? '收起文件列表' : `再显示 ${changes.length - PREVIEW_COUNT} 个文件`} <ChevronDown size={14} /></button>}
    </div>
    {confirming && createPortal(<div className="file-undo-backdrop"><div aria-labelledby="file-undo-title" aria-modal="true" className="file-undo-dialog" ref={dialog} role="dialog">
      <h2 id="file-undo-title">撤销本轮文件改动？</h2>
      <p>将恢复 {eligible.length} 个文件到本轮修改前的状态。新建文件会移入恢复目录；之后被修改过的文件将跳过，不会覆盖。</p>
      {current.length !== eligible.length && <p>另外 {current.length - eligible.length} 个文件已撤销或不支持自动撤销。</p>}
      <footer><button disabled={undoing} onClick={() => setConfirming(false)} type="button">取消</button><button disabled={undoing || busy} onClick={() => void undo()} type="button">{undoing ? '正在撤销…' : `确认撤销 ${eligible.length} 个文件`}</button></footer>
    </div></div>, document.body)}
  </section>
}

function target(change: TaskFileChange): LocalArtifactTarget {
  return { rootId: change.rootId, rootName: change.rootName, path: change.path, name: change.name,
    initialView: 'review', review: { action: change.action, backupPath: change.backupPath, addedLines: change.addedLines, deletedLines: change.deletedLines } }
}

function actionLabel(action: TaskFileChange['action']): string {
  return ({ created: '新建', updated: '修改', copied: '复制', moved: '移动', deleted: '删除' })[action]
}
