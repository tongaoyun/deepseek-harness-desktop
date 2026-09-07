import type { CSSProperties } from 'react'
import body from './assets/qoder/expert-body.gif'
import hand from './assets/qoder/expert-hand.gif'

type MascotVariant = 'brand' | 'hero' | 'avatar' | 'expert' | 'skill' | 'connector' | 'knowledge'
type Props = { size?: number; variant?: MascotVariant }

export function XiaoyinMascot({ size = 48, variant = 'brand' }: Props) {
  return <span aria-label="小胤吉祥物" className={`xiaoyin-mascot qoder-mascot ${variant}`} role="img" style={{ '--mascot-size': `${size}px` } as CSSProperties}>
    <img alt="" aria-hidden="true" className="mascot-motion" draggable={false} src={body} />
    {variant === 'expert' && <img alt="" aria-hidden="true" className="mascot-hand mascot-motion" draggable={false} src={hand} />}
    <svg aria-hidden="true" className="mascot-still" viewBox="0 0 100 100" fill="none"><path d="M12 48C12 26 29 14 47 18C61 20 68 30 80 34C88 37 92 44 92 53V84H12V48Z" fill="#93E5A2"/><path d="M34 29C40 40 65 38 60 25C55 16 49 36 68 40" stroke="#151B18" strokeWidth="4" strokeLinecap="round"/><ellipse cx="40" cy="54" rx="10" ry="14" fill="white"/><ellipse cx="62" cy="55" rx="10" ry="14" fill="white"/><ellipse cx="42" cy="56" rx="4.8" ry="7.5" fill="#141A17"/><ellipse cx="64" cy="57" rx="4.8" ry="7.5" fill="#141A17"/></svg>
  </span>
}
