import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('built expert package transfers load without Node module or worker factories', async () => {
  const client = await readFile(new URL('../../../packages/extensions/ui-deepseek-harness-product/lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /require\(["'](?:node:)?(?:module|worker_threads)["']\)/u)
})
