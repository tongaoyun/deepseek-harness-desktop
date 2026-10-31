/** Generate the pre-ready feed mapping used by isolated native update installations. */

/**
 * Register feed mapping without delaying evaluation of Electron's ESM entry.
 * @param {{githubRepository: string, origin: string}} options Fixture repository and loopback feed origin.
 * @returns {string} Bootstrap source with app and session supplied by the entry module.
 */
export function nativeUpdateFeedBootstrap({ githubRepository, origin }) {
  const urls = ['nightly.yml', 'nightly-mac.yml'].map(name =>
    `https://github.com/${githubRepository}/releases/latest/download/${name}*`)
  return `app.once('ready', () => {
  const updateSession = session.fromPartition('electron-updater', { cache: false })
  updateSession.webRequest.onBeforeRequest({ urls: ${JSON.stringify(urls)} }, (details, callback) => {
    callback({ redirectURL: ${JSON.stringify(origin)} + new URL(details.url).pathname.split('/').at(-1) })
  })
  app.on('will-quit', () => updateSession.webRequest.onBeforeRequest(null))
})
`
}
