/**
 * The web checkpoint gate's own focused self-tests (K4, #257 — the
 * ticket's "focused tests" list): every failure mode the checkpoint must
 * catch is proven RED here against synthetic reporter output, the green
 * shape is proven green, and the CI-configuration law (exactly one
 * authoritative product-web job) is proven against the live workflow
 * file. Run with `npm run test:web-gate` (node:test, deterministic,
 * network-free — the real battery itself is `npm run check:web`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  CASE_ID_SEPARATOR,
  deriveCases,
  parseInventory,
  serializeInventory,
  validateCheckpoint,
} from './check-web-checkpoint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The synthetic workspace root anchoring every synthetic report. */
const WORKSPACE = '/workspace';

// ——— synthetic reporter-output factory ———

/**
 * Builds a minimal well-formed Playwright JSON report from a case list.
 * `case`: `{ project, file, title, expectedStatus?, statuses?, annotations? }`
 * — `file` is rootDir-relative, exactly like the real reporter emits it.
 */
function reportFromCases(cases, { rootDir = WORKSPACE } = {}) {
  const entries = cases.map((testCase) => ({
    project: testCase.project,
    file: testCase.file,
    title: testCase.title,
    expectedStatus: testCase.expectedStatus ?? 'passed',
    statuses: testCase.statuses ?? ['passed'],
    annotations: testCase.annotations ?? [],
  }));
  const byFile = new Map();
  for (const entry of entries) {
    const bucket = byFile.get(entry.file) ?? [];
    bucket.push(entry);
    byFile.set(entry.file, bucket);
  }
  const suites = [...byFile.entries()].map(([file, fileCases]) => ({
    title: basename(file),
    file,
    specs: fileCases.map((entry) => ({
      title: entry.title,
      tests: [
        {
          projectName: entry.project,
          expectedStatus: entry.expectedStatus,
          file,
          annotations: entry.annotations.map((type) => ({ type })),
          results: entry.statuses.map((status) => ({ status })),
        },
      ],
    })),
  }));
  const isSkipped = (entry) => entry.expectedStatus !== 'passed';
  const isFailed = (entry) =>
    entry.statuses.some((status) => status === 'failed' || status === 'timedOut');
  const isFlaky = (entry) => entry.statuses.some((status) => status === 'flaky');
  const stats = {
    startTime: '2026-09-04T00:00:00.000Z',
    duration: 1,
    expected: entries.filter((entry) => !isSkipped(entry) && !isFailed(entry) && !isFlaky(entry))
      .length,
    skipped: entries.filter(isSkipped).length,
    unexpected: entries.filter(isFailed).length,
    flaky: entries.filter(isFlaky).length,
  };
  return { config: { rootDir }, suites, stats, errors: [] };
}

/** The minimal two-case green shape the inventory agrees with. */
const GREEN_CASES = [
  { project: 'chromium', file: 'e2e/web/launcher.spec.ts', title: 'the launcher lists projects' },
  { project: 'plain-build', file: 'e2e/plain-build.spec.ts', title: 'the plain fixture builds' },
];

function greenInventoryFor(cases) {
  const ids = cases.map((entry) =>
    [entry.project, entry.file, entry.title].join(CASE_ID_SEPARATOR),
  );
  return JSON.stringify({ version: 1, description: 'test', totalCases: ids.length, caseIds: ids });
}

function codesOf(verdict) {
  return new Set(verdict.findings.map((finding) => finding.code));
}

// ——— the checkpoint's green shape ———

test('a fully green battery matching the inventory passes', () => {
  const verdict = validateCheckpoint({
    report: reportFromCases(GREEN_CASES),
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.cases.length, 2);
});

// ——— the ID shape: rootDir-relative spec paths normalize to repo-relative ———

test('rootDir-relative spec paths normalize to repo-relative case IDs', () => {
  // The live reporter's exact shapes: the e2e-rooted project reports
  // `web/x.spec.ts`, the apps/web-rooted project reports
  // `../apps/web/e2e/y.spec.ts` — both against a rootDir inside e2e.
  const report = reportFromCases(
    [
      { project: 'chromium', file: 'web/css-write.spec.ts', title: 'auto-write lands' },
      {
        project: 'chromium-content',
        file: '../apps/web/e2e/content/write.spec.ts',
        title: 'a raw write lands',
      },
    ],
    { rootDir: `${WORKSPACE}/e2e` },
  );
  const { cases } = deriveCases(report, WORKSPACE);
  assert.deepEqual(cases.map((entry) => entry.file).sort(), [
    'apps/web/e2e/content/write.spec.ts',
    'e2e/web/css-write.spec.ts',
  ]);
  assert.match(cases[0].id, / :: e2e\/web\/css-write\.spec\.ts :: /);
});

test('a spec file escaping the workspace root fails as a malformed report', () => {
  const report = reportFromCases(
    [{ project: 'chromium', file: '../../outside/rogue.spec.ts', title: 'rogue' }],
    { rootDir: `${WORKSPACE}/e2e` },
  );
  const verdict = validateCheckpoint({
    report,
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('malformed-report'));
});

test('a report without config.rootDir fails as malformed', () => {
  const report = reportFromCases(GREEN_CASES);
  delete report.config;
  const verdict = validateCheckpoint({
    report,
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('malformed-report'));
});

// ——— every fail-closed mode, proven RED ———

test('an empty report (zero discovered cases) fails', () => {
  const verdict = validateCheckpoint({
    report: reportFromCases([]),
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('empty-report'));
});

test('a missing expected case ID fails', () => {
  const verdict = validateCheckpoint({
    report: reportFromCases([GREEN_CASES[0]]),
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('missing-case'));
});

test('a focused leak (only the focused case of a spec reported) fails as missing cases with the focused hint', () => {
  const fileCases = [
    { project: 'chromium', file: 'e2e/web/css-write.spec.ts', title: 'auto-write lands' },
    { project: 'chromium', file: 'e2e/web/css-write.spec.ts', title: 'undo restores' },
  ];
  // What a leaked `test.only` produces: the focused case alone is reported.
  const focusedReport = reportFromCases([fileCases[1]]);
  const verdict = validateCheckpoint({
    report: focusedReport,
    inventoryText: greenInventoryFor(fileCases),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  const missing = verdict.findings.filter((finding) => finding.code === 'missing-case');
  assert.equal(missing.length, 1);
  assert.match(missing[0].detail, /auto-write lands/);
  assert.match(missing[0].detail, /test\.only/);
});

test('a duplicate case ID inside the report fails', () => {
  const twin = [
    { project: 'chromium', file: 'e2e/web/launcher.spec.ts', title: 'the same title twice' },
    { project: 'chromium', file: 'e2e/web/launcher.spec.ts', title: 'the same title twice' },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(twin),
    inventoryText: greenInventoryFor([twin[0]]),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('duplicate-case-id'));
});

test('a duplicate case ID inside the inventory fails', () => {
  const id = ['chromium', 'e2e/web/launcher.spec.ts', 'dup'].join(CASE_ID_SEPARATOR);
  assert.throws(
    () =>
      parseInventory(
        JSON.stringify({ version: 1, description: '', totalCases: 2, caseIds: [id, id] }),
      ),
    /duplicate/,
  );
});

test('a skipped case fails', () => {
  const cases = [
    ...GREEN_CASES,
    {
      project: 'chromium',
      file: 'e2e/web/canvas.spec.ts',
      title: 'a skipped leg',
      expectedStatus: 'skipped',
      statuses: ['skipped'],
      annotations: ['skip'],
    },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(cases),
    inventoryText: greenInventoryFor(cases),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  const nonPassed = verdict.findings.filter((finding) => finding.code === 'non-passed-case');
  assert.equal(nonPassed.length, 1);
  assert.match(nonPassed[0].detail, /skip/);
});

test('a serial-abort skip (a failure skipping its siblings) fails as non-passed too', () => {
  const cases = [
    ...GREEN_CASES,
    {
      project: 'chromium',
      file: 'e2e/web/css-write.spec.ts',
      title: 'the failing leg',
      statuses: ['failed'],
    },
    {
      project: 'chromium',
      file: 'e2e/web/css-write.spec.ts',
      title: 'the never-run sibling',
      statuses: ['skipped'],
    },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(cases),
    inventoryText: greenInventoryFor(cases),
    playwrightExitCode: 1,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  const nonPassed = verdict.findings.filter((finding) => finding.code === 'non-passed-case');
  assert.equal(nonPassed.length, 2);
  assert.match(nonPassed[1].detail, /the never-run sibling.*skipped/);
});

test('a fixme case fails with the fixme word in the finding', () => {
  const cases = [
    ...GREEN_CASES,
    {
      project: 'chromium',
      file: 'e2e/web/canvas.spec.ts',
      title: 'a fixme leg',
      expectedStatus: 'skipped',
      statuses: ['skipped'],
      annotations: ['fixme'],
    },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(cases),
    inventoryText: greenInventoryFor(cases),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  const nonPassed = verdict.findings.filter((finding) => finding.code === 'non-passed-case');
  assert.equal(nonPassed.length, 1);
  assert.match(nonPassed[0].detail, /fixme/);
});

test('a todo case fails', () => {
  const cases = [
    ...GREEN_CASES,
    {
      project: 'chromium',
      file: 'e2e/web/canvas.spec.ts',
      title: 'a todo leg',
      expectedStatus: 'todo',
      statuses: [],
    },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(cases),
    inventoryText: greenInventoryFor(cases),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('non-passed-case'));
});

test('a flaky or interrupted result status fails', () => {
  const cases = [
    ...GREEN_CASES,
    {
      project: 'chromium',
      file: 'e2e/web/canvas.spec.ts',
      title: 'a flaky leg',
      statuses: ['flaky'],
    },
    {
      project: 'chromium',
      file: 'e2e/web/canvas.spec.ts',
      title: 'an interrupted leg',
      statuses: ['interrupted'],
    },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(cases),
    inventoryText: greenInventoryFor(cases),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  const nonPassed = verdict.findings.filter((finding) => finding.code === 'non-passed-case');
  assert.equal(nonPassed.length, 2);
});

test('an unregistered new case fails', () => {
  const cases = [
    ...GREEN_CASES,
    { project: 'chromium', file: 'e2e/web/new.spec.ts', title: 'a case nobody registered' },
  ];
  const verdict = validateCheckpoint({
    report: reportFromCases(cases),
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  const unregistered = verdict.findings.filter((finding) => finding.code === 'unregistered-case');
  assert.equal(unregistered.length, 1);
  assert.match(unregistered[0].detail, /new\.spec\.ts/);
});

test('a red battery fails the checkpoint even when the report looks complete', () => {
  const failing = GREEN_CASES.concat([
    {
      project: 'chromium',
      file: 'e2e/web/launcher.spec.ts',
      title: 'a failing leg',
      statuses: ['failed'],
    },
  ]);
  const verdict = validateCheckpoint({
    report: reportFromCases(failing),
    inventoryText: greenInventoryFor(failing),
    playwrightExitCode: 1,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('battery-failed'));
  assert.ok(codesOf(verdict).has('non-passed-case'));
});

// ——— truncated-result proofs ———

test('an absent report file fails', () => {
  const verdict = validateCheckpoint({
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 1,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('malformed-report'));
});

test('an unparseable (cut mid-stream) report fails', () => {
  const full = JSON.stringify(reportFromCases(GREEN_CASES));
  const cut = full.slice(0, Math.floor(full.length / 2));
  const verdict = validateCheckpoint({
    reportText: cut,
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 1,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('malformed-report'));
});

test('a report whose stats disagree with the derived case count fails as truncated', () => {
  const report = reportFromCases(GREEN_CASES);
  report.stats.expected = 7; // entries lost on the way out
  const verdict = validateCheckpoint({
    report,
    inventoryText: greenInventoryFor(GREEN_CASES),
    playwrightExitCode: 0,
    repoRoot: WORKSPACE,
  });
  assert.equal(verdict.ok, false);
  assert.ok(codesOf(verdict).has('truncated-report'));
});

// ——— inventory-file shape laws ———

test('an inventory with the wrong version, empty caseIds, or a lying totalCases fails', () => {
  const good = greenInventoryFor(GREEN_CASES);
  const wrongVersion = JSON.stringify({ ...JSON.parse(good), version: 2 });
  assert.throws(() => parseInventory(wrongVersion), /version/);
  assert.throws(
    () =>
      parseInventory(JSON.stringify({ version: 1, description: '', totalCases: 0, caseIds: [] })),
    /empty/,
  );
  const lyingTotal = JSON.stringify({ ...JSON.parse(good), totalCases: 99 });
  assert.throws(() => parseInventory(lyingTotal), /totalCases/);
  assert.throws(() => parseInventory('not json'), /valid JSON/);
});

test('serializeInventory and parseInventory round-trip byte-stably', () => {
  const ids = GREEN_CASES.map((entry) =>
    [entry.project, entry.file, entry.title].join(CASE_ID_SEPARATOR),
  );
  const serialized = serializeInventory([...ids].reverse());
  const parsed = parseInventory(serialized);
  assert.deepEqual(parsed.caseIds, [...ids].sort());
  assert.equal(serialized, serializeInventory(parsed.caseIds));
});

// ——— the CI configuration law: exactly one authoritative product-web job ———

function loadWorkflow() {
  const workflowPath = join(ROOT, '.github', 'workflows', 'ci.yml');
  const workflow = parse(readFileSync(workflowPath, 'utf8'));
  assert.equal(workflow.name, 'CI', 'the CI workflow keeps its name');
  return workflow;
}

function runCommands(job) {
  return (job.steps ?? [])
    .map((step) => (typeof step.run === 'string' ? step.run.trim() : ''))
    .filter((command) => command !== '');
}

test('CI has exactly one authoritative product-web job running the checkpoint', () => {
  const workflow = loadWorkflow();
  const jobs = Object.entries(workflow.jobs ?? {});
  const checkpointJobs = jobs.filter(([, job]) => runCommands(job).includes('npm run check:web'));
  assert.equal(
    checkpointJobs.length,
    1,
    `exactly one job may run the web checkpoint (found: ${checkpointJobs.map(([id]) => id).join(', ')})`,
  );
  assert.equal(checkpointJobs[0][0], 'product-web', 'the authoritative job is named product-web');
});

test('no other CI job carries the product battery', () => {
  const workflow = loadWorkflow();
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    if (id === 'product-web') {
      continue;
    }
    for (const command of runCommands(job)) {
      assert.doesNotMatch(
        command,
        /playwright|check:web|test:e2e/,
        `job "${id}" must not carry the product battery (found: "${command}")`,
      );
    }
  }
});

test('the product-web job runs clean, pinned, and gates its own self-tests first', () => {
  const workflow = loadWorkflow();
  const job = workflow.jobs['product-web'];
  const commands = runCommands(job);
  const setupNode = (job.steps ?? []).find((step) =>
    typeof step.uses === 'string' ? step.uses.startsWith('actions/setup-node') : false,
  );
  assert.ok(setupNode, 'the job pins its Node version via actions/setup-node');
  assert.equal(setupNode.with['node-version'], 24, 'the pinned Node version is 24');
  assert.ok(commands.includes('npm install -g npm@11.6.2'), 'npm is pinned to the packageManager');
  assert.ok(commands.includes('npm ci'), 'the job installs from the lockfile');
  assert.ok(
    (job.steps ?? []).some(
      (step) => step.run?.trim() === 'npm ci' && step['working-directory'] === 'e2e/fixture',
    ),
    'the fixture is installed for the plain-build leg of the battery',
  );
  assert.ok(
    commands.includes('npx playwright install --with-deps chromium'),
    'the job installs the browser the battery drives',
  );
  const selfTestIndex = commands.indexOf('npm run test:web-gate');
  const checkpointIndex = commands.indexOf('npm run check:web');
  assert.ok(selfTestIndex !== -1, 'the gate self-tests run in the job');
  assert.ok(checkpointIndex > selfTestIndex, 'the self-tests run before the checkpoint');
});

test('the deterministic gates stay in the check job', () => {
  const workflow = loadWorkflow();
  const commands = runCommands(workflow.jobs.check);
  for (const gate of ['npm run check', 'npm run typecheck', 'npm run test']) {
    assert.ok(commands.includes(gate), `the check job still runs "${gate}"`);
  }
});
