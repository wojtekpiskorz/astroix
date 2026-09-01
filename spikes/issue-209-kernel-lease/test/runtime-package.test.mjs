import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { nodeReleaseFor, runCommand } from '../src/runtime-package.mjs';

test('pins the official Node 24.20.0 darwin arm64 archive', () => {
  assert.deepEqual(nodeReleaseFor({ platform: 'darwin', arch: 'arm64' }), {
    filename: 'node-v24.20.0-darwin-arm64.tar.gz',
    sha256: '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
    version: 'v24.20.0',
  });
});

test('pins the official Node 24.20.0 linux x64 archive', () => {
  assert.deepEqual(nodeReleaseFor({ platform: 'linux', arch: 'x64' }), {
    filename: 'node-v24.20.0-linux-x64.tar.gz',
    sha256: '855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec',
    version: 'v24.20.0',
  });
});

test('rejects an unqualified platform instead of choosing another Node', () => {
  assert.throws(
    () => nodeReleaseFor({ platform: 'win32', arch: 'x64' }),
    (error) => error?.code === 'ASTROIX_NODE_RELEASE_UNQUALIFIED',
  );
});

test('a timed-out qualification kills its complete process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astroix-process-group-'));
  const childPidPath = join(directory, 'child-pid');
  let childPid;
  try {
    const parentSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000)'], { stdio: 'ignore' });
      writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const result = await runCommand(process.execPath, ['-e', parentSource, childPidPath], {
      processGroup: true,
      timeoutMs: 150,
    });
    childPid = Number(await readFile(childPidPath, 'utf8'));

    assert.equal(result.timedOut, true);
    assert.equal(result.processGroupClean, true);
    assert.throws(
      () => process.kill(childPid, 0),
      (error) => error?.code === 'ESRCH',
    );
  } finally {
    if (Number.isInteger(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
