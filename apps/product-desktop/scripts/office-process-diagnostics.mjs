/** Collect native Office helper stacks without changing conversion deadlines or killing converters. */
import { execFile } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

async function execute(command, args, options) {
  const operation = promisify(execFile)(command, args, { ...options, killSignal: 'SIGKILL' })
  // execFile can reject on AbortError before its child emits close.
  const closed = new Promise(resolve => operation.child.once('close', resolve))
  try { return await operation } finally { await closed }
}

/**
 * Select native helpers descended from this packaging command; never inspect command arguments.
 * @param {string} table macOS ps pid, parent pid and executable columns.
 * @param {number} rootPid Owned packaging process.
 * @returns {{pid: number, parentPid: number}[]} Owned LibreOffice helpers only.
 */
export function officeHelperProcesses(table, rootPid) {
  const processes = table.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line)
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3] }] : []
  })
  const owned = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (!owned.has(process.pid) && owned.has(process.parentPid)) { owned.add(process.pid); changed = true }
    }
  }
  return processes.filter(process => owned.has(process.pid) && basename(process.executable) === 'libreoffice-kit')
    .map(({ pid, parentPid }) => ({ pid, parentPid }))
}

/**
 * Observe long-running native helpers until packaging ends, joining any active sampling on cancellation.
 * @param {number} rootPid Owned packaging process.
 * @param {string} directory Private evidence directory, uploaded by the existing failure artifact step.
 * @param {{signal: AbortSignal, pollMs?: number, sampleAfterMs?: number, now?: () => number,
 * readProcesses?: (signal: AbortSignal) => Promise<string>,
 * sample?: (pid: number, path: string, signal: AbortSignal) => Promise<void>}} options Observation settings and test dependencies.
 * @returns {Promise<void>} Resolves on cancellation; rejects diagnostic failures without altering the packaging result.
 */
export async function observeOfficeProcesses(rootPid, directory, options) {
  const { signal, pollMs = 1000, sampleAfterMs = 20_000, now = performance.now.bind(performance) } = options
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'HOME', 'TMPDIR'].includes(name)))
  const readProcesses = options.readProcesses ?? (async signal => {
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { env, signal, timeout: 5000 })
    return stdout
  })
  const sample = options.sample ?? (async (pid, path, signal) => {
    await execute('/usr/bin/sample', [String(pid), '1', '10', '-mayDie', '-nodsyms', '-file', path],
      { env, signal, timeout: 30_000 })
  })
  const observed = new Map()
  const sampled = new Set()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    while (!signal.aborted) {
      const helpers = officeHelperProcesses(await readProcesses(signal), rootPid)
      const live = new Set(helpers.map(({ pid }) => pid))
      for (const pid of observed.keys()) if (!live.has(pid)) { observed.delete(pid); sampled.delete(pid) }
      for (const helper of helpers) {
        const firstSeen = observed.get(helper.pid)
        if (firstSeen === undefined) {
          observed.set(helper.pid, now())
          await appendFile(join(directory, 'office-processes.log'), `${JSON.stringify({ event: 'helper-observed', ...helper })}\n`, { mode: 0o600 })
        } else if (!sampled.has(helper.pid) && now() - firstSeen >= sampleAfterMs) {
          sampled.add(helper.pid)
          await appendFile(join(directory, 'office-processes.log'), `${JSON.stringify({ event: 'helper-sample', ...helper, elapsedMs: now() - firstSeen })}\n`, { mode: 0o600 })
          try { await sample(helper.pid, join(directory, `office-${helper.pid}.log`), signal) }
          catch (error) {
            if (signal.aborted) throw error
            // A helper can exit between ps and sample; preserve that diagnostic outcome without retrying it.
            const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
            const termination = error !== null && typeof error === 'object' ? {
              signal: typeof error.signal === 'string' ? error.signal : null, killed: error.killed === true,
            } : {}
            await appendFile(join(directory, 'office-processes.log'), `${JSON.stringify({ event: 'sample-failed', pid: helper.pid, code,
              elapsedMs: now() - firstSeen, ...termination })}\n`, { mode: 0o600 })
          }
        }
      }
      await delay(pollMs, undefined, { signal })
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
}
