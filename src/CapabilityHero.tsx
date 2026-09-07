import { Puzzle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { XiaoyinMascot } from './XiaoyinMascot'
import { KnowledgeHeroArt } from './KnowledgeHeroArt'
import connectorsArt from './assets/qoder/connectors.svg'
import presentationArt from './assets/qoder/presentation.svg'
import infographicArt from './assets/qoder/infographic.svg'
import researchArt from './assets/qoder/research.svg'

type HeroKind = 'experts' | 'skills' | 'connectors' | 'knowledge'
const scenes = [
  { title: '金融行业', description: '研报、经营分析与财务流程整合到对话，用套件组织常用模板与数据源。' },
  { title: '法律行业', description: '合同审查、条款比对与检索路径预置，减少重复说明，专注结论输出。' },
  { title: '市场营销', description: '文案撰写、竞品追踪与活动策划场景化打包，统一团队工作方法。' },
]
const covers = [presentationArt, infographicArt, researchArt]

export function CapabilityHero({ kind, highlights = [], onOpenHighlight }: {
  kind: HeroKind
  highlights?: { id: string; name: string; summary?: string }[]
  onOpenHighlight?: (id: string) => void
}) {
  const [sceneIndex, setSceneIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (kind !== 'experts' || paused || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => setSceneIndex((index) => (index + 1) % scenes.length), 5500)
    return () => window.clearInterval(timer)
  }, [kind, paused])
  const copy = kind === 'experts' ? scenes[sceneIndex] : kind === 'skills'
    ? { title: '为你精选的职场技能', description: '技能按任务自动触发，也可以通过 / 选择或在提示词中直接点名。' }
    : kind === 'connectors'
      ? { title: '连接你的应用，释放生产力', description: '连接真实应用与数据，扩展小胤的工作能力。' }
      : { title: '让每一次回答，都有据可循', description: '把文档、工作流程和团队经验整理在一起，让小胤帮你查资料、找答案。' }
  return <section className={`capability-hero reference-hero ${kind}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}>
    {kind === 'experts' && <div aria-label="专家套件场景" className="hero-scene-switcher">{scenes.map((item, index) => <button aria-label={`切换场景：${item.title}`} aria-pressed={sceneIndex === index} key={item.title} onClick={() => setSceneIndex(index)} type="button" />)}</div>}
    <div className="capability-hero-copy"><div className="hero-scene-copy" key={`${kind}-${sceneIndex}`}><strong>{copy.title}</strong><p>{copy.description}</p></div>{kind === 'knowledge' && <ul aria-label="知识库能力" className="knowledge-hero-features"><li>资料归档</li><li>知识检索</li><li>原文引用</li></ul>}</div>
    {kind === 'experts' && <div className="expert-hero-stage"><div aria-hidden="true" className="expert-hero-tags">{['财务分析', '合同管理', '市场营销', '产品设计', '企业财税', '研发协作'].map((name) => <span key={name}><Puzzle size={13} />{name}</span>)}</div><XiaoyinMascot size={84} variant="expert" /></div>}
    {kind === 'skills' && <div aria-label="快速浏览技能" className="skill-hero-postcards">{covers.map((cover, index) => {
      const skill = highlights[index]
      const illustration = <img alt="" className="postcard-cover" src={cover} />
      return skill && onOpenHighlight ? <button aria-label={`查看技能：${skill.name}`} className={`skill-postcard card-${index}`} key={skill.id} onClick={() => onOpenHighlight(skill.id)} type="button">{illustration}<strong>{skill.name}</strong><small>{skill.summary || '查看技能详情'}</small></button> : <div aria-hidden="true" className={`skill-postcard card-${index}`} key={index}>{illustration}</div>
    })}</div>}
    {kind === 'connectors' && <img alt="" className="connector-reference-art" src={connectorsArt} />}
    {kind === 'knowledge' && <KnowledgeHeroArt />}
  </section>
}
