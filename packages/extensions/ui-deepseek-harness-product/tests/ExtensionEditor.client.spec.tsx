// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionPreview } from '../src/client/ExtensionPreview.tsx'
import { ExpertKitDetailPage } from '../src/client/ExpertKitView.tsx'
import { detail, knowledgeReferenceDetails } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('preserves an imported skill preview after a rejected save', async () => {
  const invoke = vi.fn(async (_namespace: string, method: string) => method === 'extensions.save'
    ? { ok: false, error: 'failed', failure: { code: 'EXTENSION_REVIEW_CONFLICT', message: 'private', retryable: false, resources: [] } }
    : { ok: true, result: {} })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const onSaved = vi.fn()
  render(<ExtensionPreview t={key => zh[key]} onClose={() => undefined} onSaved={onSaved} onContinue={async () => undefined}
    preview={{ stageId: '00000000-0000-4000-8000-000000000001', missingFields: [], files: [{ path: 'SKILL.md', bytes: 40 }], draft: {
      kind: 'skill',
      id: 'review-policy', name: 'Review policy', summary: 'Review facts', version: '1.0.0', category: 'legal',
      triggers: ['Policy review'], body: 'Retained Markdown', stageId: '00000000-0000-4000-8000-000000000001',
    } }} />)
  fireEvent.click(screen.getByRole('button', { name: zh.saveAndInstall }))
  expect((await screen.findByRole('alert')).textContent).toContain(zh.resourceConflict)
  expect(screen.getByText('Review policy')).toBeTruthy()
  expect(screen.getByText('Retained Markdown')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(onSaved).not.toHaveBeenCalled()
})

it('orders kit details and does not render startup checks or skill readiness badges', () => {
  const product = detail({ id: 'policy-kit', name: 'Policy kit', author: 'Author', version: '1.0.0', visibility: 'PERSONAL',
    skillIds: ['review-policy'], skillDetails: [{ id: 'review-policy', name: 'Review policy', summary: 'Review facts' }],
    connectorRefs: [], knowledgeBaseRefs: [] }, { readme: '# Guide\n\nFixed guide.' })!
  render(<ExpertKitDetailPage detail={product} t={key => zh[key]} actionPending={false} actionError={undefined}
    installed={false} installationsKnown onInstall={() => undefined}
    onBack={() => undefined} onUse={() => undefined} />)
  expect(screen.getAllByRole('heading', { level: 2 }).map(value => value.textContent)).toEqual([
    `${zh.includedSkills} 1`, `${zh.dataConnections} 0`, `${zh.knowledgeScope} 0`, zh.kitGuide,
  ])
  expect(screen.queryByText('就绪')).toBeNull()
  expect(screen.queryByText(zh.startupChecks)).toBeNull()
  expect(screen.queryByText(zh.advancedInformation)).toBeNull()
  expect(screen.getByRole('button', { name: zh.viewFullGuide }).parentElement?.textContent).toContain('Fixed guide.')
  fireEvent.click(screen.getByRole('button', { name: zh.viewFullGuide }))
  expect(screen.getByRole('dialog', { name: zh.kitGuide }).textContent).toContain('Fixed guide.')
})

it('resolves stable knowledge references to real IDs and distinguishes denial, absence and network failure', () => {
  expect(knowledgeReferenceDetails(['company:policy'], [{ reference: 'company:policy', status: 'RESOLVED',
    base: { id: 'actual-base', name: 'Policy', scope: 'COMPANY', companyId: 'company' } }])).toMatchObject([{ id: 'actual-base', name: 'Policy', available: true }])
  expect(knowledgeReferenceDetails(['personal:hidden'], [{ reference: 'personal:hidden', status: 'UNAUTHORIZED' }])).toMatchObject([{ available: false, status: 'UNAUTHORIZED' }])
  expect(knowledgeReferenceDetails(['personal:absent'], [{ reference: 'personal:absent', status: 'NOT_FOUND' }])).toMatchObject([{ available: false, status: 'NOT_FOUND' }])
  expect(knowledgeReferenceDetails(['personal:hidden'], [], true)).toMatchObject([{ available: false, status: 'LOOKUP_FAILED' }])
  expect(knowledgeReferenceDetails(['department:manual'], [{ reference: 'department:manual', status: 'RESOLVED',
    base: { id: 'department-base', name: 'Manual', scope: 'DEPARTMENT', ownerName: 'Sales' } }]))
    .toMatchObject([{ id: 'department-base', available: true, scope: 'DEPARTMENT', ownerName: 'Sales' }])
  expect(knowledgeReferenceDetails(['organization:policy'], [{ reference: 'company:policy', status: 'RESOLVED',
    base: { id: 'actual-base', name: 'Policy', scope: 'COMPANY' } }]))
    .toMatchObject([{ id: 'organization:policy', available: false, status: 'LOOKUP_FAILED' }])
})
