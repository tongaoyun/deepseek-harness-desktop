import { describe, expect, it } from 'vitest'
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
})
