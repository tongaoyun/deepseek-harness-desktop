import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NAME = 'harness-company-publish'
const scripts = dirname(fileURLToPath(import.meta.url))

/** Install the committed standalone skill; no workspace dependencies or build are required. */
export async function installPublicationSkill(directory, replace = false) {
  const target = resolve(directory)
  await mkdir(dirname(target), { recursive: true })
  let existing = false
  try {
    const stat = await lstat(target)
    if (!replace || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Target exists; use --replace only for an existing publication skill')
    const skill = await readFile(join(target, 'SKILL.md'), 'utf8')
    if (!skill.startsWith(`---\nname: ${NAME}\n`)) throw new Error('Target is not the company publication skill')
    existing = true
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const stage = await mkdtemp(join(dirname(target), `.${NAME}-`))
  let backup
  try {
    await mkdir(join(stage, 'scripts'))
    await copyFile(join(scripts, '../skills', NAME, 'SKILL.md'), join(stage, 'SKILL.md'))
    for (const name of ['publish-company-content.mjs', 'company-content-codec.mjs']) {
      await copyFile(join(scripts, '../skills', NAME, 'scripts', name), join(stage, 'scripts', name))
    }
    if (existing) {
      backup = `${stage}-previous`
      await rename(target, backup)
    }
    try { await rename(stage, target) }
    catch (error) { if (backup) await rename(backup, target); throw error }
    if (backup) await rm(backup, { recursive: true, force: true })
  } finally { await rm(stage, { recursive: true, force: true }) }
  return { installed: true, directory: target, requires: 'Node.js >=22.19', credentialsIncluded: false }
}

async function main() {
  const args = process.argv.slice(2)
  const replace = args.includes('--replace')
  const values = args.filter(arg => arg !== '--replace')
  if (values.length !== 2 || !['--client', '--directory'].includes(values[0])) throw new Error('Usage: --client codex|claude|both | --directory output-directory [--replace]')
  if (values[0] === '--directory') return [await installPublicationSkill(values[1], replace)]
  if (!['codex', 'claude', 'both'].includes(values[1])) throw new Error('Invalid client')
  const clients = values[1] === 'both' ? ['codex', 'claude'] : [values[1]]
  const results = []
  for (const client of clients) {
    const root = client === 'codex' ? process.env.CODEX_HOME ?? join(homedir(), '.codex') : join(homedir(), '.claude')
    results.push(await installPublicationSkill(join(root, 'skills', NAME), replace))
  }
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Skill installation failed; check the target and the complete repository skill directory. No credentials were copied.'); process.exitCode = 1 })
}
