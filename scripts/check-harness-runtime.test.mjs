import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkHarnessCommand, DEFAULT_HARNESS_SMOKE_TIMEOUT_MS, harnessSmokeTimeout } from './check-harness-runtime.mjs'

test('uses a bounded explicit smoke timeout', () => {
  assert.equal(harnessSmokeTimeout({}), DEFAULT_HARNESS_SMOKE_TIMEOUT_MS)
  assert.equal(harnessSmokeTimeout({ XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: '' }), DEFAULT_HARNESS_SMOKE_TIMEOUT_MS)
  assert.equal(harnessSmokeTimeout({ XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: '120000' }), 120_000)
  for (const value of ['0', '-1', '1.5', ' 120000', 'invalid', '600001', '9007199254740992']) {
    assert.throws(() => harnessSmokeTimeout({ XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS: value }), /XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS/)
  }
})

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

test('waits for the capability self-test and rejects missing or failed checks', async () => {
  const fixture = `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    let pending = false;
    const methods = ['host.initialize', 'host.health', 'host.self-test', 'host.shutdown'];
    lines.on('line', line => {
      const r = JSON.parse(line);
      if (pending || r.method !== methods.shift()) process.exit(2);
      pending = true;
      setTimeout(() => {
        pending = false;
        const status = { 'host.initialize': 'initialized', 'host.health': 'ready', 'host.self-test': 'passed', 'host.shutdown': 'closed' }[r.method];
        const checks = ['local-files', 'office-runtime', 'office-skills', 'libreoffice-kit', 'native-shell', 'computer-use']
          .filter(key => key !== process.env.OMIT_CHECK)
          .map(key => ({ key, passed: key !== process.env.FAIL_CHECK }));
        console.log(JSON.stringify({ id: r.id, result: { status, checks } }));
      }, 20);
    });
    lines.on('close', () => process.exit(pending || methods.length ? 3 : 0));
  `
  await checkHarnessCommand(process.execPath, ['-e', fixture], process.env, 5000, { selfTest: true })
  for (const env of [{ OMIT_CHECK: 'office-skills' }, { FAIL_CHECK: 'native-shell' }]) {
    await assert.rejects(
      checkHarnessCommand(process.execPath, ['-e', fixture], { ...process.env, ...env }, 5000, { selfTest: true }),
      /Installed capabilities were not verified/,
    )
  }
})

test('can assert required Harness capabilities on the health response', async () => {
  const fixture = `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    const methods = ['host.initialize', 'host.health', 'host.shutdown'];
    lines.on('line', line => {
      const r = JSON.parse(line);
      if (r.method !== methods.shift()) process.exit(2);
      const result = r.method === 'host.health'
        ? { status: 'ready', capabilities: { sessionPersistence: 'enabled', sessionQuery: 'gated' } }
        : { status: r.method === 'host.initialize' ? 'initialized' : 'closed' };
      console.log(JSON.stringify({ id: r.id, result }));
    });
  `
  await checkHarnessCommand(process.execPath, ['-e', fixture], process.env, 5000, {
    requiredCapabilities: ['sessionPersistence', 'sessionQuery'],
  })
  await assert.rejects(
    checkHarnessCommand(process.execPath, ['-e', fixture], process.env, 5000, {
      requiredCapabilities: ['sessionPersistence', 'sessionReference'],
    }),
    /capabilities were not reported/u,
  )
})

test('verifies enabled and gated runtime capabilities exactly', async () => {
  const fixture = `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', line => {
      const r = JSON.parse(line);
      const result = r.method === 'host.health'
        ? { status: 'ready', capabilities: { shell: 'gated', persistentTerminal: 'gated' } }
        : { status: r.method === 'host.initialize' ? 'initialized' : 'closed' };
      console.log(JSON.stringify({ id: r.id, result }));
    });
  `
  await checkHarnessCommand(process.execPath, ['-e', fixture], process.env, 5000, {
    expectedCapabilities: { shell: 'gated', persistentTerminal: 'gated' },
  })
  await assert.rejects(
    checkHarnessCommand(process.execPath, ['-e', fixture], process.env, 5000, {
      expectedCapabilities: { shell: 'enabled' },
    }),
    /shell expected enabled, got gated/u,
  )
})
