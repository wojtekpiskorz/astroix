import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const privateStateDirectory = await mkdtemp(join(tmpdir(), 'astroix-lease-snapshot-'));

function waitForMessage(child, types, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${types.join(' or ')}`)),
      timeoutMs,
    );
    const onMessage = (message) => {
      if (!types.includes(message?.type)) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

let holder;
try {
  holder = spawn(
    process.execPath,
    [
      join(moduleDirectory, 'lease-holder.mjs'),
      JSON.stringify({ privateStateDirectory, role: 'registry-writer' }),
    ],
    {
      env: {
        ASTROIX_EXPECTED_NODE: 'v24.20.0',
        PATH: '/usr/bin:/bin',
        ...(typeof process.env.TMPDIR === 'string' ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  await waitForMessage(holder, ['ready']);
  holder.send({ type: 'start' });
  const acquired = await waitForMessage(holder, ['acquired', 'denied']);
  assert.equal(acquired.type, 'acquired', JSON.stringify(acquired));
  const directoryMetadata = await stat(privateStateDirectory);
  const fileMetadata = await stat(join(privateStateDirectory, 'registry-writer.sqlite'));
  const filesystem = await statfs(privateStateDirectory);
  holder.send({ type: 'shutdown' });
  assert.deepEqual(await waitForExit(holder), { code: 0, signal: null });

  console.log(
    `QUALIFICATION_SNAPSHOT ${JSON.stringify({
      acquisitionMs: acquired.elapsedMs,
      embeddedSqliteVersion: process.versions.sqlite,
      extensionsDisabled: acquired.extensionsDisabled,
      filesystem: {
        blockSize: Number(filesystem.bsize),
        type: String(filesystem.type),
      },
      journalMode: acquired.journalMode,
      leaseFileMode: (fileMetadata.mode & 0o777).toString(8).padStart(4, '0'),
      node: {
        arch: process.arch,
        platform: process.platform,
        version: process.version,
      },
      privateDirectoryMode: (directoryMetadata.mode & 0o777).toString(8).padStart(4, '0'),
      sensitiveEnvironmentAbsent: {
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === undefined,
        nodeOptions: process.env.NODE_OPTIONS === undefined,
        proofSecret: process.env.ASTROIX_PROOF_SECRET === undefined,
      },
      sqliteSourceId: acquired.sqliteSourceId,
      sqliteVersion: acquired.sqliteVersion,
    })}`,
  );
} finally {
  if (holder?.exitCode === null && holder?.signalCode === null) {
    holder.kill('SIGKILL');
    await waitForExit(holder);
  }
  await rm(privateStateDirectory, { recursive: true, force: true });
}
