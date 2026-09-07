import { describe, expect, it, vi } from 'vitest'
import { nextCronRuns } from './cronPreview'

describe('cron preview', () => {
  it('previews a workday schedule in its declared timezone', () => {
    const values = nextCronRuns('0 9 * * 1-5', 'Asia/Shanghai', 2, new Date('2026-09-04T02:00:00Z'))
    expect(values.map((value) => value.toISOString())).toEqual([
      '2026-09-07T01:00:00.000Z', '2026-09-08T01:00:00.000Z',
    ])
  })

  it('rejects malformed expressions', () => {
    expect(nextCronRuns('bad cron', 'Asia/Shanghai')).toEqual([])
  })

  it('finds the next monthly date without depending on the machine timezone', () => {
    expect(nextCronRuns('0 9 1 * *', 'Asia/Shanghai', 1, new Date('2026-09-07T02:00:00Z'))
      .map((value) => value.toISOString())).toEqual(['2026-10-01T01:00:00.000Z'])
  })

  it('finds sparse schedules without starting timers', () => {
    vi.useFakeTimers()
    try {
      expect(nextCronRuns('0 9 1 1 *', 'Asia/Shanghai', 1, new Date('2026-09-07T02:00:00Z'))
        .map((value) => value.toISOString())).toEqual(['2027-01-01T01:00:00.000Z'])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('requires both the day of month and weekday to match', () => {
    expect(nextCronRuns('0 9 1 * 1', 'Asia/Shanghai', 1, new Date('2026-09-07T02:00:00Z'))
      .map((value) => value.toISOString())).toEqual(['2027-02-01T01:00:00.000Z'])
  })

  it('keeps the one-year horizon and rejects impossible dates', () => {
    const from = new Date('2026-09-07T02:00:00Z')
    expect(nextCronRuns('0 9 29 2 *', 'Asia/Shanghai', 1, from)).toEqual([])
    expect(nextCronRuns('0 9 30 2 *', 'Asia/Shanghai', 1, from)).toEqual([])
  })

  it.each(['0 0 9 * * *', '99 9 * * *', '*/0 9 * * *', '*/2/3 9 * * *', '0 9 1-2-3 * *'])('rejects invalid expression %s', (expression) => {
    expect(nextCronRuns(expression, 'Asia/Shanghai')).toEqual([])
  })

  it('rejects invalid timezones, dates and counts', () => {
    expect(nextCronRuns('* * * * *', 'invalid/timezone')).toEqual([])
    expect(nextCronRuns('* * * * *', '')).toEqual([])
    expect(nextCronRuns('* * * * *', 'UTC', 1, new Date('invalid'))).toEqual([])
    for (const count of [0, -1, 0.5, Infinity, NaN]) expect(nextCronRuns('* * * * *', 'UTC', count)).toEqual([])
  })

  it('uses the next matching minute after the provided instant', () => {
    expect(nextCronRuns('*/15 * * * *', 'Asia/Kathmandu', 2, new Date('2026-09-07T02:00:00Z'))
      .map((value) => value.toISOString())).toEqual(['2026-09-07T02:15:00.000Z', '2026-09-07T02:30:00.000Z'])
  })

  it('handles DST gaps and runs once during a repeated hour', () => {
    expect(nextCronRuns('30 2 * * *', 'America/New_York', 1, new Date('2026-03-08T06:00:00Z'))
      .map((value) => value.toISOString())).toEqual(['2026-03-08T07:30:00.000Z'])
    expect(nextCronRuns('30 1 * * *', 'America/New_York', 2, new Date('2026-11-01T05:00:00Z'))
      .map((value) => value.toISOString())).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
  })
})
