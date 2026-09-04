import { ChevronDown, Files } from 'lucide-react'
import { useState } from 'react'
import type { TaskFileChange } from './types'

const PREVIEW_COUNT = 3

export function FileChangesCard({ changes }: { changes: TaskFileChange[] }) {
  const [expanded, setExpanded] = useState(false)
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
      <button aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} type="button">审核</button>
    </header>
    <div className="file-change-list">
      {visible.map((change) => <div className="file-change-row" key={change.id}>
        <span title={`${change.rootName}/${change.path}`}>{change.path}</span>
        <small>{actionLabel(change.action)}</small>
        <code>
          {change.addedLines !== undefined && <ins>+{change.addedLines}</ins>}
          {change.deletedLines !== undefined && <del>-{change.deletedLines}</del>}
        </code>
      </div>)}
    </div>
    {remaining > 0 && <button className="file-changes-more" onClick={() => setExpanded(true)} type="button">
      再显示 {remaining} 个文件 <ChevronDown size={14} />
    </button>}
  </section>
}

function actionLabel(action: TaskFileChange['action']): string {
  return ({ created: '新建', updated: '修改', copied: '复制', moved: '移动', deleted: '删除' })[action]
}
