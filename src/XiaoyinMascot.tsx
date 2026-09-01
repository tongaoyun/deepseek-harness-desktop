import type { CSSProperties } from 'react'
import mascotImage from './assets/xiaoyin-mascot.png'

type Props = { size?: number; variant?: 'brand' | 'hero' | 'avatar' }

export function XiaoyinMascot({ size = 48, variant = 'brand' }: Props) {
  return (
    <span
      aria-label="小胤吉祥物"
      className={`xiaoyin-mascot ${variant}`}
      role="img"
      style={{ '--mascot-size': `${size}px` } as CSSProperties}
    >
      <img aria-hidden="true" draggable={false} src={mascotImage} />
    </span>
  )
}
