import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('does not report an official Session as durable when its log root cannot be written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-session-write-failure-'))
  const blockedRoot = join(directory, 'sessions')
  await mkdir(blockedRoot)
  const persistence = new JsonlSessionPersistence(new Context(), { root: blockedRoot, compression: 'none' })
  const handle = await persistence.create({
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-write-failure'),
    createdAt: Date.now(),
    isSeeded: false,
  })
  try {
    await rm(blockedRoot, { recursive: true })
    await writeFile(blockedRoot, 'the session root failed after startup')
    await expect(handle.flush()).rejects.toThrow()
    const processLocal = await persistence.stat(SessionId('session-write-failure'))
    expect(String(processLocal?.revision)).toContain('memory:')
    await rm(blockedRoot)
    await mkdir(blockedRoot)
    const restarted = new JsonlSessionPersistence(new Context(), { root: blockedRoot, compression: 'none' })
    expect(await restarted.stat(SessionId('session-write-failure'))).toBeUndefined()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
