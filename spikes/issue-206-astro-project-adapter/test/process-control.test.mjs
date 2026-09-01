import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { terminateAndReap } from '../src/process-control.mjs';

test('terminateAndReap waits until a live child has closed', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const result = await terminateAndReap({ child, exit });

  assert.equal(result.signal, 'SIGTERM');
  assert.notEqual(child.signalCode, null);
});
