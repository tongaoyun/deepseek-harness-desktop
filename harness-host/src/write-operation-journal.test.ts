import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { WriteOperationJournal } from './write-operation-journal.js'

const roots: string[] = []
const journals: WriteOperationJournal[] = []
const connector = { id: 'orders', name: 'Orders', url: 'https://orders.test/mcp', command: '', arguments: [] }
const receipt = { content: [{ type: 'text' as const, text: 'ORDER-1' }] }
function path() { const root = mkdtempSync(join(tmpdir(), 'xy-journal-')); roots.push(root); return join(root, 'operations.sqlite') }
function open(file: string, scope = 'turn-1') { const journal = new WriteOperationJournal(file, scope); journals.push(journal); return journal }
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('durable MCP writes', () => {
  it('changes turn scope without replacing the running tool client', async () => {
    let scope = 'first-turn'
    const journal = new WriteOperationJournal(path(), () => scope)
    journals.push(journal)
    const call = vi.fn(async () => receipt)
    await journal.execute(connector, 'create', { marker: 'one' }, call)
    scope = 'second-turn'
    await journal.execute(connector, 'create', { marker: 'one' }, call)
    expect(call).toHaveBeenCalledTimes(2)
    scope = 'first-turn'
    await journal.execute(connector, 'create', { marker: 'one' }, call)
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('reuses a committed receipt across runtimes, with canonical arguments', async () => {
    const file = path(), call = vi.fn(async () => receipt)
    await open(file).execute(connector, 'create', { marker: 'one', amount: 50 }, call)
    expect(await open(file).execute(connector, 'create', { amount: 50, marker: 'one' }, call)).toEqual(receipt)
    expect(call).toHaveBeenCalledTimes(1)
    await open(file, 'intentional-new-turn').execute(connector, 'create', { marker: 'one', amount: 50 }, call)
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('blocks a concurrent duplicate and keeps unknown writes blocked in a new turn', async () => {
    const file = path(), first = open(file), second = open(file, 'other-turn')
    let fail!: (error: Error) => void
    const pending = first.execute(connector, 'create', { marker: 'one' }, () => new Promise((_, reject) => { fail = reject }))
    const call = vi.fn(async () => receipt)
    await expect(second.execute(connector, 'create', { marker: 'one' }, call)).rejects.toThrow('XY-OPERATION-UNCERTAIN')
    fail(new Error('connection lost'))
    await expect(pending).rejects.toThrow('XY-OPERATION-UNCERTAIN')
    await expect(second.execute(connector, 'create', { marker: 'one' }, call)).rejects.toThrow('XY-OPERATION-UNCERTAIN')
    expect(call).not.toHaveBeenCalled()
  })
  it('fails closed when persisting the success receipt fails after dispatch', async () => {
    const file = path(), journal = open(file)
    const sabotage = new DatabaseSync(file)
    sabotage.exec(`CREATE TRIGGER reject_success BEFORE UPDATE OF state ON operations
      WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`)
    sabotage.close()
    const call = vi.fn(async () => receipt)
    await expect(journal.execute(connector, 'create', { marker: 'receipt-failure' }, call)).rejects.toThrow('XY-OPERATION-UNCERTAIN')
    await expect(open(file, 'another-turn').execute(connector, 'create', { marker: 'receipt-failure' }, call)).rejects.toThrow('XY-OPERATION-UNCERTAIN')
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('does not claim or dispatch an already canceled operation', async () => {
    const journal = open(path()), call = vi.fn(async () => receipt)
    await expect(journal.execute(connector, 'create', {}, call, AbortSignal.abort())).rejects.toThrow()
    await journal.execute(connector, 'create', {}, call)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('survives an actual process kill after the external write and before the receipt', async () => {
    const file = path(), ledger = `${file}.ledger`
    const source = `import { WriteOperationJournal } from ${JSON.stringify(new URL('./write-operation-journal.ts', import.meta.url).href)};
      import { writeFileSync } from 'node:fs';
      const journal = new WriteOperationJournal(${JSON.stringify(file)}, 'turn-1');
      setInterval(() => {}, 1000);
      await journal.execute(${JSON.stringify(connector)}, 'create', {marker:'one'}, async () => {
        writeFileSync(${JSON.stringify(ledger)}, 'ORDER-1'); process.stdout.write('committed');
        return new Promise(() => {});
      });`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error('fixture exited before commit') })])
    } finally { child.kill('SIGKILL'); await exited }
    expect(readFileSync(ledger, 'utf8')).toBe('ORDER-1')
    const call = vi.fn(async () => receipt)
    await expect(open(file).execute(connector, 'create', { marker: 'one' }, call)).rejects.toThrow('XY-OPERATION-UNCERTAIN')
    expect(call).not.toHaveBeenCalled()
  }, 15000)
})
