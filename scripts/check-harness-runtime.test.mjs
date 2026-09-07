import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkHarnessCommand } from './check-harness-runtime.mjs'

test('keeps stdin open until delayed initialization, health and shutdown acknowledge', async () => {
  await checkHarnessCommand(process.execPath, ['-e', `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    let pending = false;
    lines.on('line', line => {
      if (pending) process.exit(2);
      pending = true;
      const r = JSON.parse(line);
      setTimeout(() => {
        pending = false;
        const status = { 'host.initialize': 'initialized', 'host.health': 'ready', 'host.shutdown': 'closed' }[r.method];
        console.log(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { status } }));
      }, 20);
    });
    lines.on('close', () => process.exit(pending ? 3 : 0));
  `])
})
test('rejects a failed initialization and an early exit', async () => {
  await assert.rejects(checkHarnessCommand(process.execPath, ['-e', `console.log(JSON.stringify({id:1,error:{message:'bad runtime'}}));setInterval(()=>{},1000)`]), /bad runtime/)
  await assert.rejects(checkHarnessCommand(process.execPath, ['-e', 'process.exit(0)']), /0 verified responses/)
})
test('times out and terminates an unresponsive runtime', async () => {
  await assert.rejects(checkHarnessCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, 100), /timed out/)
})
