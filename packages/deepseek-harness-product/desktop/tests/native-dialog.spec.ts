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
