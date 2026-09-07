import { Check, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SchedulePopover } from './SchedulePopover'

const pad = (n: number) => String(n).padStart(2, '0')
export function ScheduleTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const [hour, minute] = value.split(':').map(Number)
  const select = (time: string) => { setText(time); onChange(time) }
  const columns = useRef<(HTMLDivElement | null)[]>([])
  return <div className="schedule-clock-input"><input aria-label="执行时刻" required placeholder="HH:mm" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" value={text} onChange={(e) => { setText(e.target.value); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) onChange(e.target.value) }} />
    <SchedulePopover label="选择执行时刻" className="schedule-clock-popover" trigger={<Clock3 size={14} />} onOpen={() => columns.current.forEach((element, column) => { if (element) element.scrollTop = Math.max(0, (column ? minute : hour) * 30 - 60) })}>
      {() => <div className="schedule-clock-columns">{[24, 60].map((length, column) => <div key={length} role="group" aria-label={column ? '分钟' : '小时'} ref={(element) => {
        columns.current[column] = element
        if (element) element.scrollTop = Math.max(0, (column ? minute : hour) * 30 - 60)
      }}>{Array.from({ length }, (_, n) => <button type="button" key={n} aria-pressed={(column ? minute : hour) === n} onClick={() => select(column ? `${pad(hour)}:${pad(n)}` : `${pad(n)}:${pad(minute)}`)}>{pad(n)}{(column ? minute : hour) === n && <Check size={12} />}</button>)}</div>)}</div>}
    </SchedulePopover>
  </div>
}

export function ScheduleDatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [month, setMonth] = useState(value.slice(0, 7))
  useEffect(() => setMonth(value.slice(0, 7)), [value])
  const [year, m] = month.split('-').map(Number)
  const count = new Date(year, m, 0).getDate()
  const offset = (new Date(year, m - 1, 1).getDay() + 6) % 7
  const move = (by: number) => { const date = new Date(year, m - 1 + by, 1); setMonth(`${date.getFullYear()}-${pad(date.getMonth() + 1)}`) }
  return <SchedulePopover label="执行日期" className="schedule-date-popover" trigger={value}>
    {(close) => <div className="schedule-calendar"><header><button type="button" aria-label="上个月" onClick={() => move(-1)}><ChevronLeft size={14} /></button><strong>{year} 年 {m} 月</strong><button type="button" aria-label="下个月" onClick={() => move(1)}><ChevronRight size={14} /></button></header>
      <div className="schedule-date-grid">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}{Array.from({ length: offset }, (_, n) => <span key={`empty-${n}`} />)}{Array.from({ length: count }, (_, n) => {
        const date = `${month}-${pad(n + 1)}`
        return <button type="button" aria-label={date} aria-pressed={date === value} key={date} onClick={() => { onChange(date); close() }}>{n + 1}</button>
      })}</div>
    </div>}
  </SchedulePopover>
}
