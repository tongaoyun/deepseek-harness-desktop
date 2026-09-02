export interface NaturalSchedule {
  name: string
  cronExpression: string
  summary: string
}

const WEEKDAYS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
}

export function parseNaturalSchedule(value: string): NaturalSchedule {
  const source = value.trim()
  if (!source) throw new Error('请描述任务和执行时间')
  const time = parseTime(source)
  const days = parseDays(source)
  const cronExpression = `${time.minute} ${time.hour} ${days.dayOfMonth} * ${days.weekday}`
  return {
    name: source.replace(time.match, '').replace(/^(?:每个?|每天|每日|天天)\s*/, '').replace(/[，,。；;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || '定时任务',
    cronExpression,
    summary: `${days.label} ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
  }
}

function parseTime(source: string): { hour: number; minute: number; match: string } {
  const colon = source.match(/(?:每天|每日|工作日|周[一二三四五六日天、至到和及]*)?\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})[:：](\d{1,2})/)
  const chinese = source.match(/(?:每天|每日|工作日|周[一二三四五六日天、至到和及]*)?\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})\s*[点时](半|\d{1,2}\s*分?)?/)
  if (!colon && !chinese) throw new Error('没有识别到执行时间，例如“每天上午 9 点”或“工作日 18:30”')
  const period = colon?.[1] ?? chinese?.[1] ?? ''
  let hour = Number(colon?.[2] ?? chinese?.[2])
  const minuteToken = colon?.[3] ?? chinese?.[3]
  const minute = minuteToken === '半' ? 30 : Number(minuteToken?.replace(/\s*分$/, '') ?? 0)
  if ((period.includes('下午') || period.includes('晚上')) && hour < 12) hour += 12
  if (period.includes('中午') && hour < 11) hour += 12
  if (hour > 23 || minute > 59) throw new Error('执行时间无效')
  return { hour, minute, match: (colon ?? chinese)![0] }
}

function parseDays(source: string): { dayOfMonth: string; weekday: string; label: string } {
  if (/工作日|周一至周五|周一到周五/.test(source)) return { dayOfMonth: '*', weekday: '1-5', label: '每个工作日' }
  const range = source.match(/(?:每)?周([一二三四五六日天])(?:至|到)([一二三四五六日天])/) 
  if (range) return { dayOfMonth: '*', weekday: `${WEEKDAYS[range[1]]}-${WEEKDAYS[range[2]]}`, label: `每周${range[1]}至周${range[2]}` }
  const list = source.match(/(?:每)?周([一二三四五六日天](?:[、,，和及][一二三四五六日天])*)/)
  if (list) {
    const values = [...list[1]].filter((value) => value in WEEKDAYS).map((value) => WEEKDAYS[value])
    return { dayOfMonth: '*', weekday: [...new Set(values)].join(','), label: `每周${list[1]}` }
  }
  if (/每月/.test(source)) {
    const day = Number(source.match(/每月\s*(\d{1,2})\s*[号日]/)?.[1])
    if (!day || day > 31) throw new Error('请写明每月几号执行')
    return { dayOfMonth: String(day), weekday: '*', label: `每月 ${day} 日` }
  }
  if (/每天|每日|天天/.test(source)) return { dayOfMonth: '*', weekday: '*', label: '每天' }
  throw new Error('没有识别到重复周期，例如“每天”“工作日”或“每周一、三”')
}
