import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Real Host process, with EOF and hard-crash fault injection confined to its own group. */
export class EvaluationHost {
  constructor() {
    this.requests = new Map()
    this.sequence = 0
    this.child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
      env: process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.child.stdin.on('error', () => {})
    this.exit = new Promise(resolve => {
      const finish = () => {
        for (const request of this.requests.values()) request.reject(new Error('Harness Host process exited'))
        this.requests.clear()
        resolve()
      }
      this.child.once('exit', finish)
      this.child.once('error', finish)
    })
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line)
      if (message.method === 'session.notification') this.onNotification?.(message.params.event)
      else if (message.method === 'approval.request') {
        // Evaluation tasks use registered local file tools and the isolated order fixture only.
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method: 'approval.respond',
          params: { approvalId: message.params.approvalId, decision: 'reject' } }) + '\n')
      } else if (this.requests.has(message.id)) {
        const request = this.requests.get(message.id)
        this.requests.delete(message.id)
        if (message.error) request.reject(new Error(message.error.message))
        else request.resolve(message.result)
      }
    })
  }

  run(input, onNotification) {
    this.onNotification = onNotification
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'session.run', params: input }) + '\n')
    })
  }

  async crash() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' }).once('close', resolve))
      } else {
        try { process.kill(-this.child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    await this.exit
  }

  async close() {
    this.child.stdin.end()
    const timer = setTimeout(() => { void this.crash() }, 5000)
    try { await this.exit } finally { clearTimeout(timer) }
  }
}
