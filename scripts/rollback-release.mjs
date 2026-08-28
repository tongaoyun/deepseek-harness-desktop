const [version] = process.argv.slice(2)

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Provide a valid released semantic version, for example 0.1.0.')
}

const server = (process.env.GITEA_SERVER_URL || 'http://192.168.2.66:3300').replace(/\/$/, '')
const owner = 'instudio'
const username = process.env.RELEASE_USERNAME
const credential = process.env.RELEASE_CREDENTIAL
if (!username || !credential) throw new Error('Release publisher credentials are missing.')

const auth = `Basic ${Buffer.from(`${username}:${credential}`, 'utf8').toString('base64')}`
const packageBase = `${server}/api/packages/${owner}/generic/xiaoyin-desktop/${version}`
const immutableMetadataUrl = `${packageBase}/latest.json`
const latestMetadataUrl = `${server}/api/packages/${owner}/generic/xiaoyin-desktop-updater/latest/latest.json`
const latestPackageApi = `${server}/api/v1/packages/${owner}/generic/xiaoyin-desktop-updater/latest`

const sourceResponse = await fetch(immutableMetadataUrl)
if (!sourceResponse.ok) throw new Error(`Released metadata is unavailable: HTTP ${sourceResponse.status}`)
const sourceText = await sourceResponse.text()
const source = JSON.parse(sourceText)
const windows = source?.platforms?.['windows-x86_64']
if (source.version !== version || !windows?.signature || typeof windows.url !== 'string') {
  throw new Error('Released metadata does not satisfy the Xiaoyin updater contract.')
}
if (!windows.url.startsWith(`${packageBase}/`)) {
  throw new Error('Released metadata points outside its immutable package version.')
}

const installerResponse = await fetch(windows.url, { method: 'HEAD' })
if (!installerResponse.ok) throw new Error(`Released installer is unavailable: HTTP ${installerResponse.status}`)

const deleteResponse = await fetch(latestPackageApi, {
  method: 'DELETE',
  headers: { Authorization: auth },
})
if (!deleteResponse.ok && deleteResponse.status !== 404) {
  throw new Error(`Unable to replace latest updater metadata: HTTP ${deleteResponse.status}`)
}

const publishResponse = await fetch(latestMetadataUrl, {
  method: 'PUT',
  headers: {
    Authorization: auth,
    'Content-Type': 'application/json',
  },
  body: sourceText,
})
if (!publishResponse.ok) throw new Error(`Unable to publish rollback metadata: HTTP ${publishResponse.status}`)

const verifyResponse = await fetch(latestMetadataUrl)
if (!verifyResponse.ok) throw new Error(`Rollback metadata read-back failed: HTTP ${verifyResponse.status}`)
const verified = await verifyResponse.json()
if (verified.version !== version || verified?.platforms?.['windows-x86_64']?.signature !== windows.signature) {
  throw new Error('Rollback metadata read-back did not match the selected signed release.')
}

console.log(`Latest Xiaoyin desktop release now points to signed version ${version}.`)
