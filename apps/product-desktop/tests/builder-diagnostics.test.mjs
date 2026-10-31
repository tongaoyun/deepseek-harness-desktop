import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withBuilderDiagnostics } from '../scripts/builder-diagnostics.mjs'

test('native hooks retain their context, completion, result and failure while recording separate phases', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-builder-diagnostics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const context = {}
  const calls = []
  const failure = new Error('signature rejected')
  const config = {
    afterExtract: async value => { assert.equal(value, context); calls.push('extract') },
    afterPack: async value => { assert.equal(value, context); calls.push('pack'); return 'verified' },
    afterSign: async value => { assert.equal(value, context); calls.push('sign'); throw failure },
  }
  assert.equal(withBuilderDiagnostics(config, undefined), config)
  const diagnostic = withBuilderDiagnostics(config, directory)
  await diagnostic.afterExtract(context)
  assert.equal(await diagnostic.afterPack(context), 'verified')
  await assert.rejects(diagnostic.afterSign(context), error => error === failure)
  assert.deepEqual(calls, ['extract', 'pack', 'sign'])
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const assembly = events.find(event => event.type === 'builder-assembly-end')
  assert(assembly.elapsedMs >= 0)
  assert(assembly.cpu.user >= 0)
  assert(assembly.memory.rss > 0)
  assert(assembly.peakRssKiB > 0)
  assert.deepEqual(events.filter(event => event.type === 'stage-end').map(({ stage, success }) => ({ stage, success })), [
    { stage: 'builder:after-pack', success: true }, { stage: 'builder:after-sign', success: false },
  ])
})
