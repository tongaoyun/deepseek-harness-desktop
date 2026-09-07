import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cases = [
  { id: 'code-restart', script: 'acceptance-code-task.mjs', args: [] },
  ...['spreadsheet', 'document', 'clarification'].map((id) => ({ id, script: 'evaluate-office-task.mjs', args: [id] })),
]
const repeats = Number(process.env.XIAOYIN_EVAL_REPEATS ?? 1)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('XIAOYIN_EVAL_REPEATS must be 1..10')
if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ cases: cases.map((item) => item.id), repeats, realModel: true }, null, 2))
} else {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required')
  if (!JSON.parse(process.env.XIAOYIN_ACCEPTANCE_SKILL_DIRS ?? '[]').length) throw new Error('XIAOYIN_ACCEPTANCE_SKILL_DIRS is required for code evaluation')
  const root = resolve(process.env.XIAOYIN_EVAL_REPORT_DIR ?? `output/evaluation-${new Date().toISOString().replaceAll(':', '-')}`)
  await mkdir(root, { recursive: true })
  const results = []
  for (let run = 1; run <= repeats; run++) {
    for (const scenario of cases) {
      const reportPath = join(root, `${scenario.id}-${run}.json`)
      const started = performance.now()
      const outcome = await new Promise((done) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL(scenario.script, import.meta.url)), ...scenario.args], {
          env: { ...process.env, XIAOYIN_ACCEPTANCE_REPORT: reportPath }, stdio: ['ignore', 'ignore', 'ignore'], detached: process.platform !== 'win32',
        })
        let timedOut = false
        let killTimer
        const stop = (signal) => {
          if (!child.pid) return
          try {
            if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            else process.kill(-child.pid, signal)
          } catch { /* The process may have exited before its timeout callback. */ }
        }
        const timeout = setTimeout(() => { timedOut = true; stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 5_000) }, 10 * 60_000)
        child.once('error', () => { clearTimeout(timeout); clearTimeout(killTimer); done({ exitCode: null, launchFailed: true, timedOut }) })
        child.once('close', (exitCode) => { clearTimeout(timeout); clearTimeout(killTimer); done({ exitCode, timedOut }) })
      })
      let detail
      try { detail = JSON.parse(await readFile(reportPath, 'utf8')) } catch { /* A crashed worker may not have written a report. */ }
      const result = { id: scenario.id, run, ...outcome, passed: outcome.exitCode === 0 && detail?.passed === true,
        durationMs: Math.round(performance.now() - started), metrics: detail?.metrics ?? null, reportPath,
        humanInterventions: 0, error: detail?.error ?? (detail ? null : 'Evaluation process did not produce a report') }
      results.push(result)
      console.log(JSON.stringify({ id: result.id, run, passed: result.passed, durationMs: result.durationMs }))
      const summary = { schemaVersion: 1, realModel: true, model: process.env.DSH_MODEL ?? 'deepseek-v4-flash', repeats,
        completed: results.length, planned: repeats * cases.length,
        passed: results.length === repeats * cases.length && results.every((item) => item.passed),
        successRate: results.filter((item) => item.passed).length / results.length, results }
      await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    }
  }
  if (results.some((item) => !item.passed)) process.exitCode = 1
  console.log(JSON.stringify({ report: join(root, 'summary.json') }))
}
