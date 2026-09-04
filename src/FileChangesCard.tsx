import { ChevronDown, ExternalLink, Files, FolderSearch } from 'lucide-react'
import { useState } from 'react'
import { revealLocalArtifact, type LocalArtifactTarget } from './localArtifactPreview'
import type { TaskFileChange } from './types'

const PREVIEW_COUNT = 3

export function FileChangesCard({ changes, onOpen }: { changes: TaskFileChange[]; onOpen?: (target: LocalArtifactTarget) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  if (changes.length === 0) return null
  const visible = expanded ? changes : changes.slice(0, PREVIEW_COUNT)
  const remaining = changes.length - visible.length
  const totals = changes.reduce((value, change) => ({
    added: value.added + (change.addedLines ?? 0),
    deleted: value.deleted + (change.deletedLines ?? 0),
    hasCounts: value.hasCounts || change.addedLines !== undefined || change.deletedLines !== undefined,
  }), { added: 0, deleted: 0, hasCounts: false })

  return <section aria-label="文件改动" className="file-changes-card">
    <header>
      <span className="file-changes-icon"><Files size={19} /></span>
      <span className="file-changes-heading">
        <strong>已编辑 {changes.length} 个文件</strong>
        {totals.hasCounts && <small><ins>+{totals.added}</ins> <del>-{totals.deleted}</del></small>}
      </span>
      <button aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} type="button">{expanded ? '收起' : '查看全部'}</button>
    </header>
    <div className="file-change-list">
      {visible.map((change, index) => <div className={`file-change-row ${change.action}`} key={change.id} style={{ animationDelay: `${Math.min(index * 30, 180)}ms` }}>
        <span title={`${change.rootName}/${change.path}`}>{change.path}</span>
        <small>{actionLabel(change.action)}</small>
        <code>
          {change.addedLines !== undefined && <ins>+{change.addedLines}</ins>}
          {change.deletedLines !== undefined && <del>-{change.deletedLines}</del>}
        </code>
        <span className="file-change-actions">
          <button aria-label={`打开 ${change.name}`} disabled={!onOpen || (change.action === 'deleted' && !change.backupPath)} onClick={() => onOpen?.(target(change))} title="在小胤中审查" type="button"><ExternalLink size={14} /></button>
          <button aria-label={`在文件夹中显示 ${change.name}`} disabled={change.action === 'deleted'} onClick={() => void revealChange(change, setError)} title="在文件夹中显示" type="button"><FolderSearch size={14} /></button>
        </span>
      </div>)}
    </div>
    {error && <p className="file-changes-error">{error}</p>}
    {remaining > 0 && <button className="file-changes-more" onClick={() => setExpanded(true)} type="button">
      再显示 {remaining} 个文件 <ChevronDown size={14} />
    </button>}
  </section>
}

function target(change: TaskFileChange): LocalArtifactTarget {
  return {
    rootId: change.rootId,
    rootName: change.rootName,
    path: change.path,
    name: change.name,
    review: {
      action: change.action,
      ...(change.backupPath ? { backupPath: change.backupPath } : {}),
      ...(change.addedLines === undefined ? {} : { addedLines: change.addedLines }),
      ...(change.deletedLines === undefined ? {} : { deletedLines: change.deletedLines }),
    },
  }
}

async function revealChange(change: TaskFileChange, onError: (message: string) => void) {
  onError('')
  if (change.action === 'deleted') return
  try {
    await revealLocalArtifact(target(change))
  } catch (reason) {
    onError(reason instanceof Error ? reason.message : String(reason))
  }
}

function actionLabel(action: TaskFileChange['action']): string {
  return ({ created: '新建', updated: '修改', copied: '复制', moved: '移动', deleted: '删除' })[action]
}
