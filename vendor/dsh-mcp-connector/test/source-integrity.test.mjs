import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory = root, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'upstream.json', 'local-changes.json'].includes(entry.name)) continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(new URL(entry.name + '/', directory), path + '/'));
    else files.push(path);
  }
  return files.sort();
}

test('records every authored source change against the pinned upstream files', async () => {
  const upstream = JSON.parse(await readFile(new URL('upstream.json', root), 'utf8'));
  const local = JSON.parse(await readFile(new URL('local-changes.json', root), 'utf8'));
  assert.equal(local.upstreamCommit, upstream.commit);
  const files = await inventory();
  const actual = [];
  for (const path of [...new Set([...Object.keys(upstream.files), ...files])].sort()) {
    const before = upstream.files[path] ?? null;
    const after = files.includes(path) ? digest(await readFile(new URL(path, root))) : null;
    if (before !== after) actual.push({ path, before, after });
  }
  assert.deepEqual(local.files, actual);
});
