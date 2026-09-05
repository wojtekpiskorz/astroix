#!/usr/bin/env node
/**
 * The native-execution check for the positive qualification fixture
 * (#259, L2): runs UNDER THE RUNTIME BINARY BEING PROVEN — the
 * candidate workflow spawns exactly
 *
 *   <extracted-app>/Contents/Resources/node/bin/node check.mjs \
 *     --expect-node v24.20.0 --expect-abi 137 \
 *     --expect-os darwin --expect-arch arm64
 *
 * (the artifact's own bundled stock Node, ADR-0008) — and proves, in
 * order:
 *
 *   1. the IDENTITY LAW: the executing process is Node v24.20.0
 *      (module ABI 137) on darwin arm64 — any wrong version, ABI, OS,
 *      or architecture rejects with a structured, coded verdict BEFORE
 *      the addon is ever loaded (the compiled addon cannot load under
 *      a wrong-ABI runtime; the guard names the mismatch instead of
 *      dying inside dlopen).
 *   2. the ADDON LAW: the from-source build's better-sqlite3 loads in
 *      this exact process, reports itself as 12.10.0, and executes
 *      the ticket's in-memory sequence — create (:memory:), insert,
 *      select, close — with the selected rows asserted and the close
 *      verified by the statement that must follow it.
 *
 * Exit 0 with a facts JSON on stdout when everything held; exit 1 with
 * a coded rejection JSON when any law failed; exit 2 on misuse. The
 * check reads its expectations from the flags — never from this
 * process's own facts — so the focused self-tests can prove every
 * mismatch direction deterministically without a second real runtime.
 */
import { createRequire } from 'node:module';

const REJECTION_CODES = Object.freeze({
  'wrong-node': 'the executing runtime is not the expected Node version',
  'wrong-abi': 'the executing runtime reports an unexpected module ABI',
  'wrong-os': 'the executing runtime is on an unexpected operating system',
  'wrong-arch': 'the executing runtime is on an unexpected architecture',
});

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

const expectations = {
  node: cliValue('--expect-node') ?? 'v24.20.0',
  abi: cliValue('--expect-abi') ?? '137',
  os: cliValue('--expect-os') ?? 'darwin',
  arch: cliValue('--expect-arch') ?? 'arm64',
  packageVersion: cliValue('--expect-package-version') ?? '12.10.0',
};

const actual = {
  node: process.version,
  abi: process.versions.modules ?? String(undefined),
  os: process.platform,
  arch: process.arch,
};

function reject(code, expected, seen) {
  process.stdout.write(
    `${JSON.stringify(
      { executed: false, rejected: true, code, expected, actual: seen, law: REJECTION_CODES[code] },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}

// ——— 1. the identity law, before the addon is ever touched ———

if (actual.node !== expectations.node) reject('wrong-node', expectations.node, actual);
if (actual.abi !== expectations.abi) reject('wrong-abi', expectations.abi, actual);
if (actual.os !== expectations.os) reject('wrong-os', expectations.os, actual);
if (actual.arch !== expectations.arch) reject('wrong-arch', expectations.arch, actual);

// ——— 2. the addon law: load, identify, execute ———

let betterSqlite3;
let packageVersion;
try {
  const require = createRequire(import.meta.url);
  betterSqlite3 = require('better-sqlite3');
  packageVersion = String(require('better-sqlite3/package.json').version);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(
      {
        executed: false,
        rejected: true,
        code: 'addon-not-loaded',
        expected: { package: 'better-sqlite3', version: expectations.packageVersion },
        actual: { runtime: actual, error: error instanceof Error ? error.message : String(error) },
        law: 'the from-source build must load under exactly this runtime',
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}
if (packageVersion !== expectations.packageVersion) {
  process.stdout.write(
    `${JSON.stringify(
      {
        executed: false,
        rejected: true,
        code: 'wrong-package-version',
        expected: expectations.packageVersion,
        actual: packageVersion,
        law: 'the loaded addon is not the chartered fixture version',
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}

// the ticket's in-memory sequence, with the selected rows asserted and
// the close verified by the one statement that must not survive it
const database = betterSqlite3(':memory:');
let inserted;
let selected;
try {
  database.exec('CREATE TABLE qualification (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO qualification (fact) VALUES (?)');
  inserted =
    insert.run('bundled-node-native-addon') + insert.run('in-memory-create-insert-select-close');
  selected = database.prepare('SELECT id, fact FROM qualification ORDER BY id').all();
  const count = database.prepare('SELECT COUNT(*) AS n FROM qualification').get();
  if (
    inserted !== 2 ||
    count?.n !== 2 ||
    selected.length !== 2 ||
    selected[1]?.fact !== 'in-memory-create-insert-select-close'
  ) {
    throw new Error(
      `the in-memory sequence returned unexpected results (inserted ${String(inserted)}, count ${String(count?.n)}, rows ${JSON.stringify(selected)})`,
    );
  }
} finally {
  database.close();
}
let closedVerified = false;
try {
  database.prepare('SELECT 1');
} catch {
  closedVerified = true; // a closed database refuses new statements — the close held
}

process.stdout.write(
  `${JSON.stringify(
    {
      executed: true,
      rejected: false,
      package: 'better-sqlite3',
      packageVersion,
      runtime: actual,
      inMemory: { created: true, inserted, selected: selected.length, closed: closedVerified },
    },
    null,
    2,
  )}\n`,
);
if (!closedVerified) process.exit(1);
