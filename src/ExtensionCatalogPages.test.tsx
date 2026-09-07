import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CapabilityCatalogPage } from './ExtensionCatalogPages'

it('renders the independent skills page without duplicate kind tabs', () => {
  const noop = () => undefined
  const html = renderToStaticMarkup(<CapabilityCatalogPage
    kind="skills" onCreate={noop} loading={false} error="" filter="market" category="all"
    onFilter={noop} onCategory={noop} expertKits={[]} visibleExpertKits={[]}
    skills={[]} visibleSkills={[]} installingKitId="" onOpenExpertKit={noop} onOpenSkill={noop}
  />)
  expect(html).not.toContain('catalog-kind-tabs')
  expect(html).toContain('为你精选的职场技能')
  expect(html).toContain('技能按任务自动触发')
  expect(html).not.toMatch(/\bSkills?\b/u)
})
