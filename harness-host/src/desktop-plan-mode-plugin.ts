import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-plan-mode'

export const name = 'xiaoyin-desktop-plan-mode'
export const inject = ['planMode']

/** Keep the desktop's explicit mode in the official durable plan projection. */
export function apply(ctx: Context): void {
  const active = process.env.XIAOYIN_EXECUTION_MODE === 'plan'
  ctx.on('agent/created', ({ agent }) => {
    ctx.planMode.set(agent, active)
  })
}
