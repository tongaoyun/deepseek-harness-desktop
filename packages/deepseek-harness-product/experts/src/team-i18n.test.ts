import { TEST_TEAMS } from './fixtures/teams.ts'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { effectiveCoordinator, teamSchema } from './team-contract.ts'
import { TEAM_EN, teamText } from './team-i18n.ts'

describe('专家团完整国际化', () => {
  it('切换语言不修改自定义内容或自定义主理人规则', () => {
    const custom = { ...TEST_TEAMS[0],  coordinatorMode: 'custom' as const, coordinatorPrompt: '我的中文工作方法' }
    expect(teamSchema.parse(custom).name).toBe(custom.name)
    expect(effectiveCoordinator(custom, 'en')).toBe(custom.coordinatorPrompt)
    expect(teamText('en', '{0} 位专家', [3])).toBe('3 experts')
    expect(teamText('en', 'toString')).toBe('toString')
    expect(teamText('zh', 'Some members are disabled')).toBe('有成员未启用')
  })
  it('所有团队组件词条均有英文翻译，禁止遗漏占位符', () => {
    for (const [key, value] of Object.entries(TEAM_EN)) {
      expect([...value.matchAll(/\{\d+\}/gu)].map(m => m[0]).sort(), key).toEqual([...key.matchAll(/\{\d+\}/gu)].map(m => m[0]).sort())
    }
    for (const file of ['client/index.ts', 'client/team-confirmation.tsx', 'client/team-ui.tsx', 'client/team-editor.tsx', 'client/team-composer.tsx', 'client/team-shared.tsx', 'client/team-reference.ts', 'team-library.ts', 'remote.ts', 'expert-library.ts', 'team-runtime.ts', 'team-engine.ts', 'index.ts']) {
      const source = ts.createSourceFile(file, readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ['tx', 'teamTx'].includes(node.expression.getText(source)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          expect(TEAM_EN, `${file}: ${node.arguments[0].text}`).toHaveProperty(node.arguments[0].text)
        }
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'teamText' && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) {
          expect(TEAM_EN, `${file}: ${node.arguments[1].text}`).toHaveProperty(node.arguments[1].text)
        }
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'Error' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) {
          expect(node.arguments[0].text, `${file}: 裸中文错误需要国际化`).not.toMatch(/[\u3400-\u9fff]/u)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  })
})
