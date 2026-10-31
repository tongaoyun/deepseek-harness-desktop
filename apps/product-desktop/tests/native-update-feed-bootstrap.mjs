/** Generate the pre-ready feed mapping used by isolated native update installations. */

/**
 * Register feed mapping without delaying evaluation of Electron's ESM entry.
 * @param {{githubRepository: string, origin: string}} options Fixture repository and loopback feed origin.
 * @returns {string} Bootstrap source with app and session supplied by the entry module.
 */
export function nativeUpdateFeedBootstrap({ githubRepository, origin }) {
  const urls = ['nightly.yml', 'nightly-mac.yml'].map(name =>
    `https://github.com/${githubRepository}/releases/latest/download/${name}*`)
  urls.push(`https://api.github.com/repos/${githubRepository}/releases/latest*`,
    `https://api.github.com/repos/${githubRepository}/releases/assets/*`)
  return `app.once('ready', () => {
  const updateSession = session.fromPartition('electron-updater', { cache: false })
  updateSession.webRequest.onBeforeRequest({ urls: ${JSON.stringify(urls)} }, (details, callback) => {
    const url = new URL(details.url)
    const path = url.hostname === 'api.github.com'
      ? 'github' + url.pathname.slice(${JSON.stringify(`/repos/${githubRepository}`)}.length)
      : url.pathname.split('/').at(-1)
    callback({ redirectURL: ${JSON.stringify(origin)} + path })
  })
  app.on('will-quit', () => updateSession.webRequest.onBeforeRequest(null))
})
`
}
