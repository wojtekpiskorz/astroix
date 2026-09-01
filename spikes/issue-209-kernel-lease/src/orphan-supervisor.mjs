import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(process.argv[2] ?? '{}');
const holderPath = join(dirname(fileURLToPath(import.meta.url)), 'lease-holder.mjs');
const env = {
  ASTROIX_EXPECTED_NODE: 'v24.20.0',
  PATH: '/usr/bin:/bin',
};
if (typeof process.env.TMPDIR === 'string') env.TMPDIR = process.env.TMPDIR;

const holder = spawn(
  process.execPath,
  [
    holderPath,
    JSON.stringify({
      exitMarkerPath: config.exitMarkerPath,
      orphanHoldMs: config.orphanHoldMs,
      privateStateDirectory: config.privateStateDirectory,
      role: 'edit-writer',
    }),
  ],
  {
    env,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  },
);

holder.on('message', (message) => {
  if (message?.type === 'ready') holder.send({ type: 'start' });
  if (message?.type === 'acquired') {
    process.send?.({
      type: 'orphan-acquired',
      runtimeVersion: message.runtimeVersion ?? process.version,
    });
  }
  if (message?.type === 'denied') {
    process.send?.({ type: 'orphan-failed', error: message.error });
    process.exitCode = 75;
  }
});

holder.once('error', (error) => {
  process.send?.({ type: 'orphan-failed', error: { message: error.message } });
  process.exitCode = 75;
});
