/** Signal readiness only after both generations are running. */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

if (process.argv[2] === 'descendant') {
  process.send({ pid: process.pid })
  setInterval(() => {}, 1000)
} else {
  const child = spawn(process.execPath, [import.meta.filename, 'descendant'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  child.once('message', async message => {
    await writeFile(process.argv[2], JSON.stringify([process.pid, message.pid]))
    if (process.argv[3] === 'leave-descendant') process.exit(0)
  })
  setInterval(() => {}, 1000)
}
