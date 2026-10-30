/** Publish verified release bytes through Gitea's public generic-package download route. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { productPackageMirror } from './update-release.mjs'
import { mapReleaseWork } from './desktop-release.mjs'

/**
 * Add immutable files and verify every byte anonymously before exposing the release's latest feed.
 * Existing or uncertain writes are reconciled by listing files; matching files are read back, never replaced.
 * @param {object} release Complete, locally verified three-platform release.
 * @param {object} client Existing member-authenticated Gitea API client.
 * @param {string} apiBase Gitea API base for authenticated writes, including /api/v1.
 * @param {object} options Optional isolated anonymous read transport.
 * @returns {Promise<void>} All release files exist with matching size and SHA-256 and need no client credential.
 */
export async function publishPackageMirror(release, client, apiBase, { fetchImpl = fetch, packageUrl = productPackageMirror('example/downloads').packageUrl } = {}) {
  const configured = new URL(packageUrl)
  const match = /\/api\/packages\/([^/]+)\/generic\/([^/]+)\/$/u.exec(configured.pathname)
  if (match === null || !['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password
    || configured.search || configured.hash || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(release.version)) throw new Error('Invalid package mirror identity')
  const internal = new URL(apiBase)
  if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password
    || internal.search || internal.hash || !/\/api\/v1\/?$/u.test(internal.pathname)) throw new Error('Invalid Gitea API base')
  const [, owner, name] = match
  internal.pathname = internal.pathname.replace(/\/api\/v1\/?$/u, `/api/packages/${owner}/generic/${name}/${release.version}/`)
  const metadata = `/packages/${owner}/generic/${name}/${release.version}/files`
  let existing
  try { existing = await client.request('GET', metadata) }
  catch (error) { if (error.status !== 404) throw error; existing = [] }
  if (!Array.isArray(existing) || existing.some(file => !release.files.some(expected => expected.name === file.name))) {
    throw new Error('Package mirror contains unexpected files')
  }
  const verify = async file => {
    const result = await fetchImpl(new URL(`${release.version}/${file.name}`, configured), {
      redirect: 'error', signal: AbortSignal.timeout(15 * 60_000),
    })
    if (!result.ok) { await result.body?.cancel(); throw new Error(`Anonymous package download failed (${result.status})`) }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of result.body) {
      size += chunk.length
      if (size > file.size) throw new Error('Package mirror exceeds declared size')
      hash.update(chunk)
    }
    if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Package mirror checksum mismatch')
  }
  const transfer = async file => {
    if (!existing.some(item => item.name === file.name)) {
      const body = createReadStream(file.path)
      try {
        const response = await client.response(new URL(file.name, internal).href, { method: 'PUT', body,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }, timeoutMs: 15 * 60_000 })
        await response.body?.cancel()
      } finally { body.destroy() }
    }
    await verify(file)
  }
  // Complete payloads before publishing either native metadata file.
  await mapReleaseWork(release.files.filter(file => !/^nightly(?:-mac)?\.yml$/u.test(file.name)), transfer, 3)
  await mapReleaseWork(release.files.filter(file => /^nightly(?:-mac)?\.yml$/u.test(file.name)), transfer, 2)
}
