import { describe, expect, it } from 'vitest'
import { parseNaturalSchedule } from './scheduleLanguage'

describe('parseNaturalSchedule', () => {
  it('parses a weekday morning task', () => {
    expect(parseNaturalSchedule('每个工作日上午 9 点生成店铺日报')).toMatchObject({
      cronExpression: '0 9 * * 1-5', summary: '每个工作日 09:00', name: '生成店铺日报',
    })
  })

  it('parses selected weekdays and afternoon time', () => {
    expect(parseNaturalSchedule('每周一、三、五下午 6:30 检查库存')).toMatchObject({
      cronExpression: '30 18 * * 1,3,5',
    })
  })

  it('requires a recurring period and execution time', () => {
    expect(() => parseNaturalSchedule('帮我做日报')).toThrow('执行时间')
    expect(() => parseNaturalSchedule('上午 9 点做日报')).toThrow('重复周期')
  })
})
