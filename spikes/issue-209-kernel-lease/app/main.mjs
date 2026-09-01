import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { app } from 'electron';

import { verifyPackagedAssets } from './packaged-assets.mjs';

function childEnvironment() {
  const env = {
    ASTROIX_PROOF_PACKAGE_LAUNCH: 'electron',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  };
  if (typeof process.env.LANG === 'string') env.LANG = process.env.LANG;
  if (typeof process.env.TMPDIR === 'string') env.TMPDIR = process.env.TMPDIR;
  return env;
}

async function run() {
  await app.whenReady();
  if (!app.isPackaged) throw new Error('issue 209 requires a packaged Electron launch');
  const runtimeDirectory = join(process.resourcesPath, 'astroix-runtime');
  const assets = await verifyPackagedAssets({ resourcesPath: process.resourcesPath });
  const entry = join(runtimeDirectory, 'src', 'package-entry.mjs');
  const child = spawn(assets.nodePath, [entry, process.resourcesPath], {
    env: childEnvironment(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`bundled Node proof failed ${result.code}/${result.signal}`);
  }
}

run().then(
  () => app.exit(0),
  (error) => {
    console.error(error?.stack ?? error);
    app.exit(1);
  },
);
