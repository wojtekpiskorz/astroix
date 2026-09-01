import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPackagedAssets } from './packaged-assets.mjs';
import { assertRequiredCaseSet } from './qualification-contract.mjs';
import { runCommand } from './runtime-package.mjs';

const runtimeSourceDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = join(runtimeSourceDirectory, '..');
const resourcesPath = process.argv[2];

if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
  throw new TypeError('package resources path is required');
}

function requireSuccessful(result, label) {
  if (result.code !== 0 || result.signal !== null || result.timedOut) {
    throw new Error(
      `${label} failed ${result.code}/${result.signal}; timedOut=${String(result.timedOut)}\n${result.stdout}${result.stderr}`,
    );
  }
}

function parseSnapshot(stdout) {
  const line = stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('QUALIFICATION_SNAPSHOT '));
  if (line === undefined) throw new Error('qualification snapshot was not emitted');
  return JSON.parse(line.slice('QUALIFICATION_SNAPSHOT '.length));
}

const assets = await verifyPackagedAssets({ resourcesPath });
assert.equal(await realpath(process.execPath), assets.nodePath, 'proof escaped bundled Node');
assert.equal(process.version, assets.runtime.version, 'proof used an unqualified Node version');
assert.equal(
  process.env.ELECTRON_RUN_AS_NODE,
  undefined,
  'ELECTRON_RUN_AS_NODE crossed the boundary',
);
assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS crossed the boundary');
assert.equal(
  process.env.ASTROIX_PROOF_SECRET,
  undefined,
  'ambient proof secret crossed the boundary',
);

const testFiles = [
  'kernel-lease-interface.test.mjs',
  'kernel-lease-process.test.mjs',
  'packaged-assets.test.mjs',
  'runtime-package.test.mjs',
];
const tests = await runCommand(
  assets.nodePath,
  [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    ...testFiles.map((name) => join(runtimeDirectory, 'test', name)),
  ],
  { timeoutMs: 60_000 },
);
process.stdout.write(tests.stdout);
process.stderr.write(tests.stderr);
requireSuccessful(tests, 'kernel lease process matrix');
const cases = assertRequiredCaseSet(tests.stdout);
const testCount = Number(tests.stdout.match(/^# tests (\d+)$/m)?.[1]);
assert.equal(Number.isInteger(testCount), true, 'test runner did not report its test count');
assert.equal(testCount, cases.length, 'test count did not match the required case set');

const snapshotRun = await runCommand(
  assets.nodePath,
  [join(runtimeSourceDirectory, 'qualification-snapshot.mjs')],
  { timeoutMs: 15_000 },
);
process.stdout.write(snapshotRun.stdout);
process.stderr.write(snapshotRun.stderr);
requireSuccessful(snapshotRun, 'qualification snapshot');
const qualification = parseSnapshot(snapshotRun.stdout);

const manifest = JSON.parse(
  await readFile(join(resourcesPath, 'astroix-runtime', 'build-manifest.json'), 'utf8'),
);
const report = {
  schemaVersion: 1,
  sourceCommit: manifest.sourceCommit,
  packageLaunch: process.env.ASTROIX_PROOF_PACKAGE_LAUNCH ?? 'package-shape',
  runtime: {
    ...assets.runtime,
    embeddedSqliteVersion: process.versions.sqlite,
    executable: 'node/bin/node',
  },
  matrix: {
    passed: true,
    testCount,
    testFiles,
    cases: cases.map((name) => ({ name, passed: true })),
  },
  qualification,
  fallbacks: {
    electronRunAsNode: false,
    pathLookup: false,
    shell: false,
    systemNode: false,
  },
};

console.log(`PROOF_REPORT ${JSON.stringify(report)}`);
