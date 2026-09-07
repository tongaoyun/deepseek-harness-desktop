/** A quiet reading pose; all motion is CSS-only and has a reduced-motion fallback. */
export function KnowledgeHeroArt() {
  return <svg aria-label="小胤正在翻阅资料" className="knowledge-reading-art" role="img" viewBox="0 0 240 160" fill="none">
    <ellipse cx="134" cy="143" rx="82" ry="8" fill="#D9E8DD" opacity=".55" />
    <circle cx="139" cy="80" r="65" fill="#E5F2E8" />
    <g className="knowledge-source-sheet">
      <rect x="182" y="37" width="36" height="47" rx="6" fill="#FFFFFF" stroke="#D8E7DC" />
      <path d="M191 49H207M191 56H207M191 63H201" stroke="#BDD4C3" strokeWidth="2" strokeLinecap="round" />
      <circle cx="212" cy="79" r="9" fill="#E3F2E8" stroke="#C9E1D1" />
      <path d="M208 79L211 82L216 76" stroke="#548B67" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <g className="knowledge-reader">
      <path d="M83 65C83 40 101 24 121 27C139 29 148 41 163 46C176 50 183 60 183 74V124C183 133 174 135 166 129L156 124H100C89 124 83 117 83 107V65Z" fill="#95E3A5" />
      <path d="M109 43C118 56 145 52 138 38C132 29 122 51 151 57" stroke="#172D20" strokeWidth="4.5" strokeLinecap="round" />
      <g className="knowledge-reader-eyes">
        <ellipse cx="119" cy="78" rx="12" ry="17" fill="#FFFDF9" />
        <ellipse cx="150" cy="80" rx="12" ry="17" fill="#FFFDF9" />
        <g className="knowledge-reader-gaze">
          <ellipse cx="122" cy="84" rx="5.7" ry="9" fill="#192A20" />
          <ellipse cx="150" cy="86" rx="5.7" ry="9" fill="#192A20" />
        </g>
      </g>
    </g>
    <path d="M69 111L125 118L184 107L180 136L125 147L72 137Z" fill="#729D80" />
    <path d="M73 106C93 104 109 111 125 118C143 107 161 103 181 104L177 131C157 129 143 135 125 142C109 135 91 130 76 131Z" fill="#FFFEF9" stroke="#CEDCCF" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M125 119V141M85 115C96 116 106 119 114 123M86 122C97 123 107 127 114 130M138 121C148 116 159 114 169 114M138 128C147 124 158 121 167 121" stroke="#D8E3D8" strokeWidth="1.5" strokeLinecap="round" />
    <path className="knowledge-turning-page" d="M126 118C142 106 157 99 172 98L169 125C153 126 141 133 126 141Z" fill="#F3F7ED" stroke="#CFDDCF" strokeWidth="1.2" strokeLinejoin="round" />
    <ellipse cx="80" cy="119" rx="8" ry="12" transform="rotate(-24 80 119)" fill="#95E3A5" />
    <ellipse cx="177" cy="116" rx="8" ry="12" transform="rotate(26 177 116)" fill="#95E3A5" />
    <path d="M53 72V82M48 77H58" stroke="#A5C7AE" strokeWidth="2" strokeLinecap="round" />
    <circle cx="68" cy="48" r="3" fill="#BDD9C4" />
  </svg>
}
