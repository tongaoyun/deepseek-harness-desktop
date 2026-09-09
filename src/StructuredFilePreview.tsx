import { ChevronLeft, ChevronRight, FileText, Table2 } from 'lucide-react'
import { createElement, useState } from 'react'
import type { PreviewBlock, PreviewSheet, StructuredPreview } from './localArtifactPreview'
import './filePreview.css'

const PAGE_SIZE = 100

export function StructuredFilePreview({ value }: { value: StructuredPreview }) {
  if (value.type === 'spreadsheet') return <SpreadsheetPreview sheets={value.sheets} />
  if (value.type === 'presentation') return <PresentationPreview slides={value.slides} />
  return <div className="document-content-preview"><DocumentBlocks blocks={value.blocks} /></div>
}

function SpreadsheetPreview({ sheets }: { sheets: PreviewSheet[] }) {
  const [selected, setSelected] = useState(0)
  const [page, setPage] = useState(0)
  const sheet = sheets[selected]
  if (!sheet) return <EmptyPreview text="工作簿中没有工作表" />
  const pages = Math.max(1, Math.ceil(sheet.rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const start = currentPage * PAGE_SIZE
  const columns = Math.max(0, ...sheet.rows.map(row => row.length))
  return <div className="spreadsheet-content-preview">
    <div className="sheet-tabs" role="tablist" aria-label="工作表">{sheets.map((value, index) => <button type="button" role="tab" aria-selected={selected === index} aria-controls="sheet-content" id={`sheet-tab-${index}`} key={`${index}:${value.name}`} onClick={() => { setSelected(index); setPage(0) }}><Table2 size={14} /><span>{value.name}</span></button>)}</div>
    <div className="sheet-grid" role="tabpanel" id="sheet-content" aria-labelledby={`sheet-tab-${selected}`}>
      {sheet.rows.length ? <table aria-label={sheet.name}><thead><tr><th aria-label="行号" />{Array.from({ length: columns }, (_, index) => <th scope="col" key={index}>{columnName(index + sheet.columnOffset)}</th>)}</tr></thead>
        <tbody>{sheet.rows.slice(start, start + PAGE_SIZE).map((row, index) => <tr key={start + index}><th scope="row">{sheet.rowOffset + start + index + 1}</th>{Array.from({ length: columns }, (_, column) => {
          const cell = row[column]
          const waiting = Boolean(cell?.formula && !cell.value)
          return <td className={`${cell?.kind ?? 'text'}${waiting ? ' pending-formula' : ''}`} key={column} title={cell?.formula ? `=${cell.formula}\n${waiting ? '待重算' : '文件内保存的计算结果'}` : cell?.value}>
            <span>{waiting ? '待重算' : cell?.value}</span>{cell?.formula && <small aria-label={`公式 ${cell.formula}`}>fx</small>}
          </td>
        })}</tr>)}</tbody></table> : <EmptyPreview text="此工作表为空" />}
    </div>
    <footer className="sheet-pagination"><span>{sheet.rows.length ? `${sheet.rowOffset + start + 1}–${sheet.rowOffset + Math.min(start + PAGE_SIZE, sheet.rows.length)} 行` : '0 行'} · {columns} 列{sheet.truncated ? ' · 部分内容' : ''}</span><span><button type="button" aria-label="上一页" title="上一页" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15} /></button><small>{currentPage + 1} / {pages}</small><button type="button" aria-label="下一页" title="下一页" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={15} /></button></span></footer>
  </div>
}

function PresentationPreview({ slides }: { slides: PreviewBlock[][] }) {
  const [selected, setSelected] = useState(0)
  if (!slides.length) return <EmptyPreview text="演示稿中没有页面" />
  const index = Math.min(selected, slides.length - 1)
  return <div className="presentation-content-preview"><nav aria-label="演示稿页面">{slides.map((blocks, page) => <button type="button" aria-current={page === index ? 'page' : undefined} key={page} onClick={() => setSelected(page)}><small>{page + 1}</small><span>{slideTitle(blocks, page)}</span></button>)}</nav><div className="presentation-page"><header><span>第 {index + 1} / {slides.length} 页</span><span>内容</span></header><DocumentBlocks blocks={slides[index]} /></div></div>
}

function slideTitle(blocks: PreviewBlock[], index: number): string {
  const first = blocks.find(block => block.type === 'paragraph' && block.text.trim())
  return first?.type === 'paragraph' ? first.text : `第 ${index + 1} 页`
}

function DocumentBlocks({ blocks }: { blocks: PreviewBlock[] }) {
  if (!blocks.length) return <EmptyPreview text="没有可预览的文字内容" />
  return <article className="document-blocks">{blocks.map((block, index) => block.type === 'table'
    ? <div className="document-table-scroll" key={index}><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>
    : createElement(block.level > 0 ? `h${Math.min(6, block.level)}` : 'p', { key: index }, block.text || <br />))}</article>
}

function EmptyPreview({ text }: { text: string }) { return <div className="structured-preview-empty"><FileText size={22} /><p>{text}</p></div> }

export function columnName(index: number): string {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result
  return result
}
