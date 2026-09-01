import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleMacApp, zipAndExtractMacApp } from './src/package-app.mjs';
import { verifyPackagedAssets } from './src/packaged-assets.mjs';
import { runCommand, stageRuntimeResources } from './src/runtime-package.mjs';

const proofDirectory = dirname(fileURLToPath(import.meta.url));
const reportPath = join(proofDirectory, `REPORT.${process.platform}-${process.arch}.json`);

function requireSuccessful(result, label) {
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.processGroupClean === false
  ) {
    throw new Error(
      `${label} failed ${result.code}/${result.signal}; timedOut=${String(result.timedOut)}\n${result.stdout}${result.stderr}`,
    );
  }
}

function parseReport(stdout) {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('PROOF_REPORT '));
  if (line === undefined) throw new Error(`packaged proof emitted no report\n${stdout}`);
  return JSON.parse(line.slice('PROOF_REPORT '.length));
}

async function sourceCommit() {
  const repositoryDirectory = join(proofDirectory, '..', '..');
  const revision = await runCommand('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDirectory,
  });
  requireSuccessful(revision, 'git source revision');
  const status = await runCommand('/usr/bin/git', ['status', '--porcelain'], {
    cwd: repositoryDirectory,
  });
  requireSuccessful(status, 'git source status');
  return `${revision.stdout.trim()}${status.stdout.length === 0 ? '' : '+working-tree'}`;
}

async function makePoisonPath(temporaryDirectory) {
  const directory = join(temporaryDirectory, 'poison-path');
  const marker = join(temporaryDirectory, 'path-fallback-used');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const script = `#!/bin/sh\n/bin/echo "$0" >> ${JSON.stringify(marker)}\nexit 97\n`;
  await Promise.all(
    ['node', 'nodejs', 'sh', 'bash', 'env'].map(async (name) => {
      const path = join(directory, name);
      await writeFile(path, script, { mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  return { directory, marker };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function launchEnvironment({ poisonPath, temporaryDirectory, packageLaunch, proofSecret = true }) {
  return {
    ASTROIX_PROOF_PACKAGE_LAUNCH: packageLaunch,
    ...(proofSecret ? { ASTROIX_PROOF_SECRET: 'must-not-cross-the-runtime-boundary' } : {}),
    HOME: join(temporaryDirectory, 'home'),
    LANG: 'C.UTF-8',
    PATH: poisonPath,
    TMPDIR: temporaryDirectory,
  };
}

async function runMac({ commit, temporaryDirectory, poison }) {
  const packageDirectory = join(temporaryDirectory, 'package');
  const packaged = await assembleMacApp({
    outputDirectory: packageDirectory,
    proofDirectory,
    sourceCommit: commit,
  });
  const extracted = await zipAndExtractMacApp({
    appPath: packaged.appPath,
    outputDirectory: packageDirectory,
  });
  const launched = await runCommand(extracted.executablePath, [], {
    env: launchEnvironment({
      packageLaunch: 'signed-electron-zip-extraction',
      poisonPath: poison.directory,
      temporaryDirectory,
    }),
    processGroup: true,
    timeoutMs: 120_000,
  });
  process.stdout.write(launched.stdout);
  process.stderr.write(launched.stderr);
  requireSuccessful(launched, 'signed packaged Electron proof');
  return {
    ...parseReport(launched.stdout),
    package: {
      electron: packaged.electron,
      layout: ['astroix-runtime/', 'node/'],
      signatureVerifiedAfterZipExtraction: true,
    },
  };
}

async function runLinux({ commit, temporaryDirectory, poison }) {
  const resourcesPath = join(temporaryDirectory, 'package-resources');
  await mkdir(resourcesPath, { recursive: true, mode: 0o700 });
  const staged = await stageRuntimeResources({
    proofDirectory,
    resourcesPath,
    sourceCommit: commit,
  });
  const assets = await verifyPackagedAssets({ resourcesPath });
  assert.equal(assets.nodePath, staged.nodePath, 'Linux package escaped bundled Node');
  const launched = await runCommand(
    assets.nodePath,
    [join(staged.runtimeDirectory, 'src', 'package-entry.mjs'), resourcesPath],
    {
      env: {
        ...launchEnvironment({
          packageLaunch: 'linux-ci-package-shape',
          poisonPath: poison.directory,
          proofSecret: false,
          temporaryDirectory,
        }),
      },
      processGroup: true,
      timeoutMs: 90_000,
    },
  );
  process.stdout.write(launched.stdout);
  process.stderr.write(launched.stderr);
  requireSuccessful(launched, 'Linux package-shaped proof');
  return parseReport(launched.stdout);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'astroix-issue-209-proof-'));
let passed = false;
try {
  await rm(reportPath, { force: true });
  await mkdir(join(temporaryDirectory, 'home'), { recursive: true, mode: 0o700 });
  const poison = await makePoisonPath(temporaryDirectory);
  const commit = await sourceCommit();
  const report =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? await runMac({ commit, temporaryDirectory, poison })
      : process.platform === 'linux' && process.arch === 'x64'
        ? await runLinux({ commit, temporaryDirectory, poison })
        : (() => {
            throw new Error(`unqualified proof host ${process.platform}/${process.arch}`);
          })();
  assert.equal(await pathExists(poison.marker), false, 'a PATH fallback executable ran');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        ...report,
        host: {
          arch: process.arch,
          platform: process.platform,
        },
        poisonPathUnused: true,
      },
      null,
      2,
    )}\n`,
  );
  passed = true;
  console.log(`qualification report written to ${reportPath}`);
  console.log(`FINAL_PROOF_REPORT ${JSON.stringify(report)}`);
} finally {
  if (passed) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } else {
    console.error(`proof workspace retained at ${temporaryDirectory}`);
  }
}
