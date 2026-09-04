import type { CSSProperties } from 'react'
import mascotImage from './assets/xiaoyin-mascot.png'
import connectorMascotImage from './assets/xiaoyin-mascot-connector.png'
import expertMascotImage from './assets/xiaoyin-mascot-expert.png'
import skillMascotImage from './assets/xiaoyin-mascot-skill.png'

type MascotVariant = 'brand' | 'hero' | 'avatar' | 'expert' | 'skill' | 'connector'
type Props = { size?: number; variant?: MascotVariant }

const variantImages: Partial<Record<MascotVariant, string>> = {
  expert: expertMascotImage,
  skill: skillMascotImage,
  connector: connectorMascotImage,
}

export function XiaoyinMascot({ size = 48, variant = 'brand' }: Props) {
  return (
    <span
      aria-label="小胤吉祥物"
      className={`xiaoyin-mascot ${variant}`}
      role="img"
      style={{ '--mascot-size': `${size}px` } as CSSProperties}
    >
      <img aria-hidden="true" draggable={false} src={variantImages[variant] ?? mascotImage} />
    </span>
  )
}
