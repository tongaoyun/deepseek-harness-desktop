// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { attachmentStorageReferences } from './AttachmentStoragePanel'
const localStorage = new class implements Storage {
  values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}()
it('retains references across accounts, drafts, schedules and queues without collecting secrets', () => {
  localStorage.clear()
  for (const key of ['xiaoyin.task-drafts.a', 'xiaoyin.task-history.b', 'xiaoyin:local-schedules:v1:a', 'xiaoyin:task-queue:b']) localStorage.setItem(key, JSON.stringify({ path: key }))
  localStorage.setItem('xiaoyin.connector-secrets.a', 'do-not-read')
  expect(attachmentStorageReferences(localStorage)).toHaveLength(4)
  localStorage.clear()
})
it('refuses cleanup when another account has unreadable reference data', () => {
  localStorage.setItem('xiaoyin.task-drafts.other', '{invalid')
  expect(() => attachmentStorageReferences(localStorage)).toThrow()
  localStorage.clear()
})
