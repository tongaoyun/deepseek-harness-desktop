import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { companyContentRelease, contentDigest } from '../src/company-content.ts'
import { invokeContentSubmission } from '../src/content-submission-bridge.ts'
const document = await readFile(new URL('./fixtures/team.json', import.meta.url), 'utf8')
it('submits one self-contained team through the authenticated product bridge and rejects resource spoofing', async () => {
  const files = { 'teams/orders.json': Buffer.from(document).toString('base64') }
  expect(companyContentRelease({ version: '1.0.0', files, sha256: contentDigest(files) }).files).toEqual(files)
  const request = vi.fn(async () => ({ status: 'SUBMITTED' }))
  const api = { request }
  const signal = new AbortController().signal
  await invokeContentSubmission('content.submissions.submit', { resourceKey: 'teams/orders', files }, api, signal)
  expect(request).toHaveBeenCalledWith('/api/v1/company-content/submissions', expect.objectContaining({ method: 'POST', signal }))
  await expect(invokeContentSubmission('content.submissions.submit', { resourceKey: 'teams/other', files }, api, signal)).rejects.toThrow()
  await expect(invokeContentSubmission('content.submissions.submit', { resourceKey: 'teams/orders', files, ownerEmployeeId: 'spoofed' }, api, signal)).rejects.toThrow()
})
