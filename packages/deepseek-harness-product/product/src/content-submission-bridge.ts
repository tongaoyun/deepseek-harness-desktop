/** Native company-content submission access; credentials remain in the authenticated API client. */
import { z } from 'zod'
import { companyContentRelease, contentDigest } from './company-content.ts'

/** Validate one resource and either read its review status or submit it idempotently.
 * @param method - Product-owned submission operation.
 * @param input - Renderer files and native resource key, without identity claims.
 * @param api - Main-process authenticated client.
 * @param lifetime - Caller and employee-identity cancellation.
 * @returns Review status and safe business results.
 */
export async function invokeContentSubmission(method: string, input: Readonly<Record<string, unknown>>,
  api: { request(path: string, init?: RequestInit): Promise<unknown> }, lifetime: AbortSignal): Promise<unknown> {
  const candidate = z.object({ resourceKey: z.string().regex(/^(?:skills|experts|teams)\/[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    files: z.record(z.string(), z.string()) }).strict().parse(input)
  if (Object.keys(candidate.files).length > 2048 || Object.values(candidate.files).reduce((size, value) => size + value.length, 0) > 44_744_704) throw new Error('提交内容超过大小限制')
  const sha256 = contentDigest(candidate.files)
  const release = companyContentRelease({ version: '1.0.0', sha256, files: candidate.files })
  const team = candidate.resourceKey.startsWith('teams/')
  const skill = candidate.resourceKey.startsWith('skills/')
  const name = candidate.resourceKey.slice(candidate.resourceKey.indexOf('/') + 1)
  if (!Object.keys(release.files).length || Object.keys(release.files).some(path => team ? path !== candidate.resourceKey + '.json' : skill
    ? !path.startsWith(candidate.resourceKey + '/') : !path.startsWith('experts/') || !path.endsWith('/' + name + '.md'))
    || !skill && Object.keys(release.files).length !== 1) throw new Error('一次只能提交一个技能、专家或专家团')
  const payload = { ...candidate, sha256 }
  if (method === 'content.submissions.inspect') {
    const status = await api.request('/api/v1/company-content/submission-status?' + new URLSearchParams({ resourceKey: candidate.resourceKey, sha256 }).toString(), { signal: lifetime })
    return { sha256, fileCount: Object.keys(release.files).length, status }
  }
  return api.request('/api/v1/company-content/submissions', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: lifetime })
}
