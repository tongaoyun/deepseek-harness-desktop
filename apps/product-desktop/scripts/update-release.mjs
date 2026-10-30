/** Assemble native updater metadata from verified, immutable product installers. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * Select the product's binary-only package; source repository visibility is independent.
 * @param {string} repository Public GitHub fallback owner/name.
 * @returns {{packageUrl: string, githubRepository: string}} Credential-free installer metadata.
 */
export function productPackageMirror(repository) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)) throw new Error('Invalid GitHub fallback repository')
  return { packageUrl: 'http://www.instudio.me:6206/traefik/gitea/api/packages/instudio/generic/deepseek-harness-desktop-internal/',
    githubRepository: repository }
}

/** @param {string} repository Public download owner/name. @returns {string} Anonymous native update feed. */
export function productUpdateUrl(repository) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)) {
    throw new Error('A public GitHub download repository owner/name is required')
  }
  return `https://github.com/${repository}/releases/latest/download/`
}

/** @param {string | undefined} mode Requested distribution mode; omitted retains development packaging. @returns {'signed' | 'unsigned' | 'internal'} Validated mode. */
export function productSigningMode(mode = 'unsigned') {
  if (!['signed', 'unsigned', 'internal'].includes(mode)) throw new Error('Desktop signing mode must be signed, unsigned or internal')
  return mode
}

/** @param {string} target Native build target. @param {object} signature Actual platform signing facts. @param {string} expectedSHA256 Fixed public macOS certificate pin. @returns {void} Rejects a missing, replaced or wrongly classified internal identity. */
export function validateInternalSignature(target, signature, expectedSHA256) {
  if (target === 'win-x64') {
    if (signature?.type !== 'unsigned' || Object.keys(signature).length !== 1) throw new Error('Internal Windows builds must declare their unsigned status')
  } else if (!/^[A-F0-9]{64}$/u.test(expectedSHA256 ?? '') || signature?.type !== 'self-signed'
    || signature.certificateSHA256 !== expectedSHA256 || Object.keys(signature).length !== 2) {
    throw new Error('Internal macOS builds must use the pinned self-signed identity')
  }
}

/**
 * Validate every native feed entry against the actual payload before exposing one complete release.
 * @param {object[]} manifests Verified target manifests.
 * @param {object[]} files Verified payloads and their local paths.
 * @param {string} repository Anonymous download repository.
 * @param {string} version Common package version.
 * @param {string} releaseDate Exact build start time.
 * @returns {Promise<{ name: string, bytes: string }[]>} Windows and combined Intel/ARM Mac feeds with immutable URLs.
 */
export async function productUpdateFeeds(manifests, files, repository, version, releaseDate) {
  const { dump, load } = await import('js-yaml')
  const url = productUpdateUrl(repository)
  const byName = new Map(files.map(file => [file.name, file]))
  const feeds = new Map()
  for (const manifest of manifests) {
    if (!['signed', 'internal'].includes(manifest.signing) || manifest.updateUrl !== url || manifest.channel !== 'nightly') {
      throw new Error(`Invalid ${manifest.target} signed update configuration`)
    }
    const source = byName.get(`${manifest.target}-nightly.yml`)
    if (!source || source.size > 64 * 1024) throw new Error(`Missing ${manifest.target} native update metadata`)
    const metadata = load(await readFile(source.path, 'utf8'))
    const extension = manifest.target === 'win-x64' ? '.exe' : '.zip'
    if (!metadata || metadata.version !== version || !Array.isArray(metadata.files)
      || metadata.files.length === 0 || metadata.files.length > 4) throw new Error('Invalid native update metadata')
    const entries = []
    const seen = new Set()
    for (const entry of metadata.files) {
      const payload = manifest.artifacts.find(file => file.name === entry.url && /\.(?:exe|zip|dmg)$/u.test(file.name))
      if (!payload || seen.has(entry.url) || entry.size !== payload.size
        || typeof entry.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(entry.sha512)) {
        throw new Error(`Native update entry does not match ${manifest.target} payload`)
      }
      if (manifest.target !== 'win-x64' && payload.name.includes('arm64') !== (manifest.target === 'mac-arm64')) {
        throw new Error('Mac updater payload architecture differs from its target')
      }
      seen.add(entry.url)
      const hash = createHash('sha512')
      for await (const chunk of createReadStream(byName.get(payload.name).path)) hash.update(chunk)
      if (hash.digest('base64') !== entry.sha512) throw new Error('Native update SHA-512 mismatch')
      if (entry.blockMapSize !== undefined && (!Number.isSafeInteger(entry.blockMapSize) || entry.blockMapSize <= 0 || entry.blockMapSize > payload.size)) {
        throw new Error('Invalid native update blockmap size')
      }
      entries.push({ url: `https://github.com/${repository}/releases/download/v${version}/${payload.name}`,
        sha512: entry.sha512, size: payload.size,
        ...(entry.blockMapSize === undefined ? {} : { blockMapSize: entry.blockMapSize }) })
    }
    if (entries.filter(entry => entry.url.endsWith(extension)).length !== 1) throw new Error(`Missing native ${extension} update payload`)
    if (manifest.target === 'win-x64' && entries.length !== 1) throw new Error('Unexpected Windows update payload')
    const name = manifest.target === 'win-x64' ? 'nightly.yml' : 'nightly-mac.yml'
    feeds.set(name, [...(feeds.get(name) ?? []), ...entries])
  }
  return [...feeds].map(([name, entries]) => {
    // Legacy fields are still read by the native provider; select Intel for the combined Mac fallback.
    const primary = entries.find(entry => entry.url.endsWith(name === 'nightly.yml' ? '.exe' : '.zip') && !entry.url.includes('arm64'))
    return { name, bytes: dump({ version, files: entries, path: primary.url, sha512: primary.sha512, releaseDate }, { lineWidth: -1, noRefs: true }) }
  })
}
