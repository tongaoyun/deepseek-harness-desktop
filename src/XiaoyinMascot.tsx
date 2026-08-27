import type { CSSProperties } from 'react'

type Props = { size?: number; variant?: 'brand' | 'hero' | 'avatar' }

export function XiaoyinMascot({ size = 48, variant = 'brand' }: Props) {
  return (
    <span
      aria-label="小胤吉祥物"
      className={`xiaoyin-mascot ${variant}`}
      role="img"
      style={{ '--mascot-size': `${size}px` } as CSSProperties}
    >
      <svg aria-hidden="true" viewBox="0 0 104 96">
        <ellipse className="mascot-shadow" cx="48" cy="86" rx="28" ry="4" />
        <g className="mascot-float">
          <path className="mascot-fin" d="M66 31c10-8 20-14 29-15 5-1 7 2 5 7-3 9-11 17-23 22L66 31Z" />
          <path className="mascot-body" d="M19 31C27 17 46 12 62 19c15 6 23 21 20 37-3 17-15 27-32 29-18 2-34-4-40-17-6-13-1-28 9-37Z" />
          <path className="mascot-belly" d="M13 65c11 10 27 13 42 8 10-3 18-10 25-19-2 16-14 27-30 30-18 2-34-4-40-17l3-2Z" />
          <g className="mascot-sprout">
            <path className="mascot-stem" d="M50 20c1-8 0-13-3-17" />
            <path className="mascot-leaf" d="M47 10C39 10 34 6 34 1c8-1 13 2 13 9Z" />
            <path className="mascot-leaf" d="M49 9c2-7 7-10 14-8-1 6-6 10-14 8Z" />
          </g>
          <g className="mascot-brows"><path d="M25 34l13 7" /><path d="M65 34l-13 7" /></g>
          <g className="mascot-eye-unit"><ellipse className="mascot-eye-white" cx="34" cy="52" rx="11" ry="15" /><ellipse className="mascot-pupil" cx="36" cy="53" rx="5.5" ry="9" /><circle className="mascot-eye-glint" cx="38" cy="49" r="1.7" /></g>
          <g className="mascot-eye-unit right"><ellipse className="mascot-eye-white" cx="58" cy="52" rx="11" ry="15" /><ellipse className="mascot-pupil" cx="60" cy="53" rx="5.5" ry="9" /><circle className="mascot-eye-glint" cx="62" cy="49" r="1.7" /></g>
          <path className="mascot-mouth" d="M41 70c4 4 10 4 14 0" />
          <ellipse className="mascot-cheek" cx="20" cy="65" rx="4" ry="2" /><ellipse className="mascot-cheek" cx="72" cy="65" rx="4" ry="2" />
        </g>
      </svg>
    </span>
  )
}
