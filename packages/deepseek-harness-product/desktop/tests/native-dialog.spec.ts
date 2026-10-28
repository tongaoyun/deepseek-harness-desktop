import { expect, it, vi } from 'vitest'
import { waitForNativeDialog } from '../src/native-dialog.ts'

it('does not start a native picker after cancellation', () => {
  const controller = new AbortController()
  controller.abort(new Error('Cancelled'))
  const open = vi.fn(() => Promise.resolve({ filePaths: ['/fixture'] }))
  expect(() => waitForNativeDialog(open, controller.signal)).toThrow('Cancelled')
  expect(open).not.toHaveBeenCalled()
})

it('settles cancellation before an open picker answers and consumes its late rejection', async () => {
  const controller = new AbortController()
  const dialog = Promise.withResolvers<{ filePaths: string[] }>()
  const result = waitForNativeDialog(() => dialog.promise, controller.signal)
  const failure = expect(result).rejects.toThrow('Cancelled')
  controller.abort(new Error('Cancelled'))
  await failure
  dialog.reject(new Error('Native picker closed'))
  await expect(dialog.promise).rejects.toThrow('Native picker closed')
})

it('returns an active native choice and releases its cancellation listener', async () => {
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const choice = { canceled: false, filePaths: ['/fixture'] }
  await expect(waitForNativeDialog(() => Promise.resolve(choice), controller.signal)).resolves.toBe(choice)
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})

it('cancels even when an earlier observer stops abort event propagation', async () => {
  const owner = new AbortController()
  owner.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() })
  const dialog = Promise.withResolvers<string>()
  const result = waitForNativeDialog(() => dialog.promise, owner.signal)
  owner.abort(new Error('Owner closed'))
  dialog.resolve('late choice')
  await expect(result).rejects.toThrow('Owner closed')
})

it('normalizes synchronous picker failures and disposes the listener', async () => {
  const owner = new AbortController()
  const remove = vi.spyOn(owner.signal, 'removeEventListener')
  await expect(waitForNativeDialog(() => { throw 'not an Error' }, owner.signal)).rejects.toThrow('Native dialog operation failed')
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})


it('keeps cancellation authoritative when opening the picker also throws', async () => {
  const owner = new AbortController()
  const result = waitForNativeDialog(() => {
    owner.abort(new Error('Owner stopped'))
    throw new Error('Picker could not open')
  }, owner.signal)
  await expect(result).rejects.toThrow('Owner stopped')
})
