import type { LocalScheduleInput } from './localSchedules'
import { frequencies, frequencyOf, type Frequency } from './scheduleTime'
import { SchedulePopover, ScheduleSelect } from './SchedulePopover'
import { ScheduleDatePicker, ScheduleTimePicker } from './ScheduleDateTimePicker'

export function ScheduleTimeFields({ value, onChange }: { value: LocalScheduleInput; onChange: (value: LocalScheduleInput) => void }) {
  const frequency = frequencyOf(value)
  const [minute, hour, day, , weekday] = value.cronExpression.split(' ')
  const changeCron = (expression: string) => onChange({ ...value, timing: undefined, cronExpression: expression })
  const choose = (kind: Frequency) => {
    const common = { ...value, timeZoneMode: 'system' as const, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    if (kind === 'once') { const at = new Date(Date.now() + 1800000); at.setSeconds(0, 0); onChange({ ...common, timing: { kind, at: at.toISOString() } }) }
    else if (kind === 'interval') onChange({ ...common, timing: { kind, minutes: 30 } })
    else onChange({ ...common, timing: undefined, timeZoneMode: kind === 'custom' ? 'fixed' : 'system', cronExpression: ({ hourly: '0 * * * *', daily: '0 9 * * *', weekly: '0 9 * * 1,2,3,4,5', monthly: '0 9 1 * *', custom: '0 9 * * 1-5' })[kind] })
  }
  const localDate = value.timing?.kind === 'once' ? new Date(value.timing.at) : undefined
  const onceValue = localDate && Number.isFinite(localDate.getTime()) ? new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  const changeOnce = (date: string, time: string) => {
    const at = new Date(`${date}T${time}`)
    if (Number.isFinite(at.getTime())) onChange({ ...value, timing: { kind: 'once', at: at.toISOString() } })
  }
  const days = weekday === '1-5' ? ['1', '2', '3', '4', '5'] : (weekday ?? '').split(',')
  return <fieldset className="schedule-time-fields"><legend>计划时间</legend>
    <div className="schedule-time-row">
    <ScheduleSelect label="执行频率" value={frequency} options={frequencies} onChange={(kind) => choose(kind as Frequency)} className="schedule-frequency" />
    {frequency === 'once' && <><ScheduleDatePicker value={onceValue.slice(0, 10)} onChange={(date) => changeOnce(date, onceValue.slice(11))} /><ScheduleTimePicker value={onceValue.slice(11)} onChange={(time) => changeOnce(onceValue.slice(0, 10), time)} /></>}
    {frequency === 'interval' && <><input aria-label="间隔分钟" type="number" min="1" max="525600" required value={value.timing?.kind === 'interval' ? value.timing.minutes : 30} onChange={(e) => onChange({ ...value, timing: { kind: 'interval', minutes: Number(e.target.value) } })} /><span>分</span></>}
    {frequency === 'hourly' && <><ScheduleSelect label="每小时分钟" value={minute} options={Array.from({ length: 60 }, (_, n) => ({ value: String(n), label: String(n).padStart(2, '0') }))} onChange={(m) => changeCron(`${m} * * * *`)} /><span>分</span></>}
    {frequency === 'monthly' && <SchedulePopover label="每月日期" className="schedule-month-picker" trigger={`每月第 ${day} 天`}>{(close) => <div className="schedule-date-grid">{Array.from({ length: 31 }, (_, n) => <button type="button" key={n} aria-pressed={Number(day) === n + 1} onClick={() => { changeCron(`${minute} ${hour} ${n + 1} * *`); close() }}>{n + 1}</button>)}</div>}</SchedulePopover>}
    {['daily', 'weekly', 'monthly'].includes(frequency) && <ScheduleTimePicker value={`${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`} onChange={(time) => { const [h, m] = time.split(':'); changeCron(`${Number(m)} ${Number(h)} ${day} * ${weekday}`) }} />}
    {frequency === 'custom' && <input aria-label="Cron 表达式" required placeholder="0 9 * * 1-5" value={value.cronExpression} onChange={(e) => changeCron(e.target.value)} />}
    </div>
    {frequency === 'weekly' && <div className="schedule-weekdays" role="group" aria-label="星期">{[1, 2, 3, 4, 5, 6, 0].map((n) => <button type="button" key={n} aria-pressed={days.includes(String(n))} onClick={() => {
      const selected = new Set(days); if (selected.has(String(n))) selected.delete(String(n)); else selected.add(String(n))
      if (selected.size) changeCron(`${minute} ${hour} * * ${[...selected].sort().join(',')}`)
    }}>{'日一二三四五六'[n]}</button>)}</div>}
    {frequency === 'custom' && <label className="schedule-custom-zone">时区<input aria-label="时区" required value={value.timeZone} onChange={(e) => onChange({ ...value, timeZone: e.target.value, timeZoneMode: 'fixed' })} /></label>}
  </fieldset>
}
