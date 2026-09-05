#!/usr/bin/env node
/**
 * The non-vacuous web protocol checkpoint (K4, #257) — the ONE
 * release-blocking product gate over the settled web suites.
 *
 *   npm run check:web               the checkpoint: runs the FULL product
 *                                   battery (`playwright test` — the root
 *                                   config's chromium / chromium-content /
 *                                   chromium-project-switch / plain-build
 *                                   projects, on the staging's
 *                                   disposable fixture copies and isolated
 *                                   port; `reuseExistingServer: false` means
 *                                   an existing server is NEVER adopted) with
 *                                   the JSON report and the streaming list
 *                                   reporter, then validates the
 *                                   reported case inventory against the
 *                                   checked-in `apps/web/e2e/checkpoint-inventory.json`.
 *                                   Fails closed on: a red battery, a missing
 *                                   or malformed (truncated) report, zero
 *                                   discovered cases, duplicate case IDs,
 *                                   any non-passed case (skip / todo / fixme /
 *                                   flaky / interrupted), and any inventory
 *                                   drift (missing expected IDs — the
 *                                   focused-leak detector, since a leaked
 *                                   `test.only` reports only the focused
 *                                   case — or unregistered new cases).
 *   npm run check:web -- --update-inventory
 *                                   regenerates the checked-in inventory from
 *                                   a real green battery run (the
 *                                   `crap --update-baseline` idiom: the file
 *                                   is derived, never hand-maintained).
 *   npm run test:web-gate           the gate's own focused self-tests
 *                                   (node:test): every failure mode above is
 *                                   proven to fail the validation, plus the
 *                                   CI-configuration law (exactly one
 *                                   authoritative product-web job).
 *
 * Layering: the root playwright config's vacuity guards (#240/#408/#432/#435
 * — floor + ceiling per family, whole-tree derived ceiling) stay load-bearing
 * and run at CONFIG LOAD inside this checkpoint's battery; this script adds
 * the case-ID inventory layer ON TOP of them, over the reporter's evidence.
 *
 * Case ID shape (documented contract, shared with the inventory file):
 *   `<playwright project> :: <repo-relative spec path, POSIX separators> :: <full test title path>`
 * — the title path is the spec title joined with ` > ` after any enclosing
 * describe titles (the file-level suite title is not part of it).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  resolve as resolvePath,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INVENTORY_PATH = join(ROOT, 'apps', 'web', 'e2e', 'checkpoint-inventory.json');
const INVENTORY_VERSION = 1;

/** ` :: ` separates the three ID segments; ` > ` joins title-path segments. */
export const CASE_ID_SEPARATOR = ' :: ';
export const TITLE_PATH_SEPARATOR = ' > ';

/** The battery's hard wall-clock bound: a hung run fails the checkpoint, never the job. */
const BATTERY_TIMEOUT_MS = 30 * 60 * 1000;

// ——— the pure validation layer (exported for the self-tests) ———

/**
 * Normalizes a path to POSIX separators (host-independent IDs and labels).
 */
function toPosix(file) {
  return file.replaceAll('\\', '/');
}

/**
 * Resolves one reported spec path to its workspace-relative POSIX form.
 * The reporter emits spec paths relative to the run's config `rootDir`
 * (observed: `web/x.spec.ts` and `../apps/web/e2e/y.spec.ts` alike), so
 * the IDs are only stable once normalized against that rootDir. Fails
 * closed when the resolved path escapes the workspace root.
 */
function repoRelativeFile(rootDir, reportedFile, repoRoot) {
  const relative = relativePath(repoRoot, resolvePath(rootDir, reportedFile));
  if (relative === '' || relative.startsWith('..') || isAbsolute(relative)) {
    throw new Error(
      `the spec file "${reportedFile}" (rootDir ${rootDir}) escapes the workspace root ${repoRoot}`,
    );
  }
  return toPosix(relative);
}

/** Builds the checkpoint case ID for one reported test entry. */
export function caseIdOf(entry) {
  return [entry.project, toPosix(entry.file), entry.titlePath.join(TITLE_PATH_SEPARATOR)].join(
    CASE_ID_SEPARATOR,
  );
}

/**
 * The run's resolved rootDir from the report's config — required before the
 * rootDir-relative spec paths can be normalized to repo-relative IDs.
 */
function reportRootDir(report) {
  const config = report.config;
  if (config === null || typeof config !== 'object') {
    throw new Error('report.config.rootDir is missing (the spec paths cannot be normalized)');
  }
  if (typeof config.rootDir !== 'string' || config.rootDir === '') {
    throw new Error('report.config.rootDir is missing (the spec paths cannot be normalized)');
  }
  return config.rootDir;
}

/**
 * Validates and builds one reported test's case entry. Every shape deviation
 * of the test, its results, or its annotations throws fail-closed.
 */
function caseEntryOf(test, spec, nestedPath, rootDir, repoRoot) {
  if (
    test === null ||
    typeof test !== 'object' ||
    typeof test.projectName !== 'string' ||
    typeof test.expectedStatus !== 'string' ||
    !Array.isArray(test.results)
  ) {
    throw new Error(`a test entry of spec "${spec.title}" is malformed`);
  }
  const file = typeof test.file === 'string' ? test.file : spec.file;
  if (typeof file !== 'string' || file === '') {
    throw new Error(`the test entry of spec "${spec.title}" carries no file path`);
  }
  const statuses = test.results.map((result) => {
    if (result === null || typeof result !== 'object' || typeof result.status !== 'string') {
      throw new Error(`a result of spec "${spec.title}" is malformed (no status)`);
    }
    return result.status;
  });
  const annotations = (test.annotations ?? []).map((annotation) =>
    annotation !== null && typeof annotation === 'object' && typeof annotation.type === 'string'
      ? annotation.type
      : '(malformed annotation)',
  );
  const entry = {
    project: test.projectName,
    file: repoRelativeFile(rootDir, file, repoRoot),
    titlePath: [...nestedPath, String(spec.title)],
    expectedStatus: test.expectedStatus,
    statuses,
    annotations,
  };
  return { id: caseIdOf(entry), ...entry };
}

/**
 * Derives the flat case list from a Playwright JSON report object.
 * Fail-closed on every shape deviation (a report that is not the reporter's
 * shape is truncated output, not an empty battery).
 *
 * `repoRoot` (absolute) anchors the normalization of the reporter's
 * rootDir-relative spec paths; `report.config.rootDir` must carry the run's
 * resolved rootDir or the report is malformed.
 *
 * Returns `{ cases, stats }` where each case is
 * `{ id, project, file, titlePath, expectedStatus, statuses, annotations }`.
 * Throws a `{ code: 'malformed-report', detail }` error on bad shape.
 */
export function deriveCases(report, repoRoot) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('report is not an object');
  }
  if (!Array.isArray(report.suites)) {
    throw new Error('report.suites is missing or not an array');
  }
  const stats = report.stats;
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) {
    throw new Error('report.stats is missing or not an object');
  }
  const rootDir = reportRootDir(report);
  const cases = [];
  const collectSpecs = (suite, nestedPath) => {
    if (suite.specs !== undefined && !Array.isArray(suite.specs)) {
      throw new Error(`suite "${suite.title}" has a non-array specs field`);
    }
    for (const spec of suite.specs ?? []) {
      if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.tests)) {
        throw new Error(`a spec entry in "${suite.title}" is malformed (tests is not an array)`);
      }
      for (const test of spec.tests) {
        cases.push(caseEntryOf(test, spec, nestedPath, rootDir, repoRoot));
      }
    }
  };
  const walk = (suite, titlePath, depth) => {
    if (suite === null || typeof suite !== 'object' || Array.isArray(suite)) {
      throw new Error('a report suite entry is not an object');
    }
    // The top-level suite title is the file name, not a case-title segment;
    // nested suites (describe blocks) are part of the title path.
    const nestedPath = depth === 0 ? titlePath : [...titlePath, String(suite.title)];
    collectSpecs(suite, nestedPath);
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) {
      throw new Error(`suite "${suite.title}" has a non-array suites field`);
    }
    for (const nested of suite.suites ?? []) {
      walk(nested, nestedPath, depth + 1);
    }
  };
  for (const suite of report.suites) {
    walk(suite, [], 0);
  }
  return { cases, stats };
}

/**
 * Parses and validates the checked-in inventory file's text. Fail-closed on
 * shape, duplicates, and the totalCases cross-check. Returns
 * `{ caseIds, totalCases }`; throws with a descriptive message otherwise.
 */
export function parseInventory(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`inventory is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('inventory is not an object');
  }
  if (parsed.version !== INVENTORY_VERSION) {
    throw new Error(
      `inventory version must be ${INVENTORY_VERSION}, got ${String(parsed.version)}`,
    );
  }
  if (!Array.isArray(parsed.caseIds) || parsed.caseIds.length === 0) {
    throw new Error('inventory caseIds is missing, empty, or not an array');
  }
  if (parsed.caseIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new Error('inventory caseIds contains a non-string or empty entry');
  }
  if (typeof parsed.totalCases !== 'number' || !Number.isInteger(parsed.totalCases)) {
    throw new Error('inventory totalCases is missing or not an integer');
  }
  const seen = new Set();
  for (const id of parsed.caseIds) {
    if (seen.has(id)) {
      throw new Error(`inventory contains the duplicate case ID "${id}"`);
    }
    seen.add(id);
  }
  if (parsed.totalCases !== parsed.caseIds.length) {
    throw new Error(
      `inventory totalCases (${parsed.totalCases}) does not match caseIds.length (${parsed.caseIds.length})`,
    );
  }
  return { caseIds: [...parsed.caseIds], totalCases: parsed.totalCases };
}

/** Serializes an inventory document (sorted IDs — byte-stable regeneration). */
export function serializeInventory(caseIds) {
  const sorted = [...new Set(caseIds)].sort();
  const document = {
    version: INVENTORY_VERSION,
    description:
      "The non-vacuous web protocol checkpoint inventory (K4, #257). Derived from a real green battery run via `npm run check:web -- --update-inventory` — never hand-maintained. Case IDs are `<playwright project> :: <repo-relative spec path> :: <full test title path>`; every `npm run check:web` validates the battery's reported cases against this exact set.",
    totalCases: sorted.length,
    caseIds: sorted,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function countBy(cases, keyOf) {
  const counts = new Map();
  for (const item of cases) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The family label a case belongs to (project + spec directory). */
export function familyOf(caseEntry) {
  const directory = dirname(toPosix(caseEntry.file));
  return `${caseEntry.project} · ${directory}`;
}

/**
 * Parses the report side of the input (an already-parsed object wins; text
 * is JSON.parsed). A text that does not parse is exactly ONE malformed-report
 * finding — validateCheckpoint's absent-or-null guard must not add a second
 * one for cut text (a second would claim the report is `null` when it is
 * cut; #440 round 1).
 */
function reportOf(input, push) {
  let report = input.report ?? null;
  if (report === null && typeof input.reportText === 'string') {
    try {
      report = JSON.parse(input.reportText);
    } catch (error) {
      push('malformed-report', `the JSON report does not parse: ${error.message}`);
    }
  }
  return report;
}

/** Derives the case list, mapping a shape failure to one malformed-report finding. */
function deriveSide(report, repoRoot, push) {
  if (report === null) {
    return { cases: [], stats: null };
  }
  try {
    return deriveCases(report, repoRoot);
  } catch (error) {
    push('malformed-report', `the JSON report is truncated or malformed: ${error.message}`);
    return { cases: [], stats: null };
  }
}

/**
 * The stats cross-check: Playwright's own counters must agree with the
 * derived case count, else the report body lost entries on its way out.
 */
function statsFindings(stats, cases, push) {
  if (stats === null || cases.length === 0) {
    return;
  }
  const counted =
    (typeof stats.expected === 'number' ? stats.expected : 0) +
    (typeof stats.skipped === 'number' ? stats.skipped : 0) +
    (typeof stats.unexpected === 'number' ? stats.unexpected : 0) +
    (typeof stats.flaky === 'number' ? stats.flaky : 0);
  if (counted !== cases.length) {
    push(
      'truncated-report',
      `report stats count ${String(counted)} cases but ${String(cases.length)} were derived — the report lost or gained entries`,
    );
  }
}

function duplicateFindings(cases, push) {
  const duplicateIds = [...countBy(cases, (entry) => entry.id).entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length > 0) {
    push(
      'duplicate-case-id',
      `the report contains duplicate case IDs: ${duplicateIds.map((id) => `"${id}"`).join(', ')}`,
    );
  }
}

function caseStatusFindings(cases, push) {
  for (const entry of cases) {
    if (entry.expectedStatus !== 'passed') {
      const annotation = entry.annotations.find((type) => type === 'skip' || type === 'fixme');
      push(
        'non-passed-case',
        `"${entry.id}" is ${annotation ? annotation : 'declared'} ${entry.expectedStatus} — skip/todo/fixme never pass a checkpoint`,
      );
      continue;
    }
    const bad = entry.statuses.filter((status) => status !== 'passed');
    if (bad.length > 0) {
      push(
        'non-passed-case',
        `"${entry.id}" finished with status ${bad.join(', ')} — only a green run passes`,
      );
    }
  }
}

/** Parses the inventory side of the input (an already-parsed object wins). */
function inventoryOf(input, push) {
  let inventory = input.inventory ?? null;
  if (inventory === null && typeof input.inventoryText === 'string') {
    try {
      inventory = parseInventory(input.inventoryText);
    } catch (error) {
      push('inventory-invalid', error.message);
    }
  }
  return inventory;
}

/** The case reconciliation: the report's IDs against the checked-in inventory's. */
function reconcileInventory(cases, inventory, push) {
  const reported = new Set(cases.map((entry) => entry.id));
  const missing = inventory.caseIds.filter((id) => !reported.has(id));
  const registered = new Set(inventory.caseIds);
  const unregistered = [...reported].sort().filter((id) => !registered.has(id));
  for (const id of missing) {
    const sameFile = cases.some((entry) => entry.file === id.split(CASE_ID_SEPARATOR)[1]);
    const hint = sameFile
      ? ' — the spec file reported SOME of its cases: a leaked test.only (focused run) or a truncated report is the likely cause'
      : '';
    push('missing-case', `expected case ID missing from the battery's report: "${id}"${hint}`);
  }
  for (const id of unregistered) {
    push(
      'unregistered-case',
      `the battery reported a case ID that is not in the checked-in inventory: "${id}" — register it via \`npm run check:web -- --update-inventory\` in the PR that adds the case`,
    );
  }
}

/**
 * The checkpoint's whole verdict over one battery run.
 *
 * `input`: `{ reportText?, report?, inventoryText?, inventory?, playwrightExitCode, repoRoot?, updateInventory? }`
 * — `repoRoot` (absolute) anchors the spec-path normalization and defaults
 * to this workspace's root. Pass no `inventory` (with `updateInventory:
 * true`) for regeneration — the per-case fail-closed checks still apply;
 * only the set comparison is deferred (it becomes the write).
 *
 * Returns `{ ok, findings, cases, counts }`. `findings` entries are
 * `{ code, detail }`; every code is a distinct, self-tests-pinned failure
 * mode.
 */
export function validateCheckpoint(input) {
  const findings = [];
  const push = (code, detail) => {
    findings.push({ code, detail });
  };

  if (input.playwrightExitCode !== 0) {
    push(
      'battery-failed',
      `the playwright battery exited with code ${String(input.playwrightExitCode)} — the checkpoint is red on the battery alone`,
    );
  }

  const report = reportOf(input, push);
  // The existing guard: a `null` report only reports as absent-or-null when
  // the text itself did not already fail to parse — cut text is one finding,
  // not two (the second would claim the report is `null` when it is cut).
  if (report === null && findings.every((finding) => finding.code !== 'malformed-report')) {
    push(
      'malformed-report',
      'the JSON report is absent or `null` (a killed run produces no report)',
    );
  }

  const { cases, stats } = deriveSide(report, input.repoRoot ?? ROOT, push);

  if (cases.length === 0) {
    push('empty-report', 'zero cases were discovered by the battery — the checkpoint is vacuous');
  }

  statsFindings(stats, cases, push);
  duplicateFindings(cases, push);
  caseStatusFindings(cases, push);

  const inventory = inventoryOf(input, push);
  if (inventory !== null && input.updateInventory !== true) {
    reconcileInventory(cases, inventory, push);
  }

  const counts = [...countBy(cases, familyOf).entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return { ok: findings.length === 0, findings, cases, counts };
}

// ——— the CLI layer (battery invocation + artifacts) ———

/**
 * Runs the full battery with the JSON report writing to `reportPath` and the
 * `list` reporter streaming to the inherited stdio — the product-web CI log
 * carries the battery's own output again (a JSON-only `--reporter=json`
 * replaced the config's reporters and silenced the whole run; the JSON
 * report still lands at `reportPath` via PLAYWRIGHT_JSON_OUTPUT_NAME, which
 * the checkpoint run itself verifies fail-closed).
 */
function runBattery(reportPath) {
  const cli = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(`the playwright CLI is not installed at ${cli} — run npm install first`);
  }
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, 'test', '--reporter=json,list'], {
      cwd: ROOT,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      // A hung battery fails the checkpoint deterministically: graceful
      // SIGTERM first (Playwright stops its webServer), then a hard kill.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    }, BATTERY_TIMEOUT_MS).unref();
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? (signal !== null ? 124 : 1), signal });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: 1, error });
    });
  });
}

function renderFindings(findings) {
  return findings.map((finding) => `  [${finding.code}] ${finding.detail}`).join('\n');
}

async function main() {
  const updateInventory = process.argv.includes('--update-inventory');
  // Fail fast on the inventory file's own state: reading it only after the
  // battery resolves would discover a missing or malformed inventory a full
  // battery run too late (the case reconciliation against the report is
  // inherently post-run; the file's own shape is not).
  let inventoryText = null;
  if (!updateInventory) {
    if (!existsSync(INVENTORY_PATH)) {
      process.stderr.write(
        `web checkpoint: the inventory file is missing at ${INVENTORY_PATH} — regenerate it with \`npm run check:web -- --update-inventory\`\n`,
      );
      process.exitCode = 1;
      return;
    }
    inventoryText = readFileSync(INVENTORY_PATH, 'utf8');
    try {
      parseInventory(inventoryText);
    } catch (error) {
      process.stderr.write(
        `web checkpoint: ${error.message} — regenerate it with \`npm run check:web -- --update-inventory\` over a green battery\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-web-checkpoint-'));
  const reportPath = join(scratch, 'checkpoint-report.json');
  try {
    process.stdout.write('web checkpoint: running the full product battery (playwright test)…\n');
    const run = await runBattery(reportPath);

    let reportText = null;
    if (existsSync(reportPath)) {
      reportText = readFileSync(reportPath, 'utf8');
    }

    const verdict = validateCheckpoint({
      reportText,
      inventoryText,
      playwrightExitCode: run.code,
      updateInventory,
    });

    // Retained artifacts (#129's doctrine — full evidence survives every
    // run, green included; the copy happens after the run, so Playwright's
    // own startup clear of test-results/ cannot eat it).
    const artifactsDir = join(ROOT, 'test-results');
    mkdirSync(artifactsDir, { recursive: true });
    const summaryLines = [
      `astroix web protocol checkpoint (K4, #257)`,
      `verdict: ${verdict.ok ? 'GREEN' : 'RED'}`,
      `cases: ${verdict.cases.length}`,
      ...verdict.counts.map((count) => `  ${count.family}: ${count.count}`),
      ...(verdict.findings.length > 0 ? ['', 'findings:', renderFindings(verdict.findings)] : []),
    ];
    if (reportText !== null) {
      copyFileSync(reportPath, join(artifactsDir, 'checkpoint-report.json'));
    }
    writeFileSync(join(artifactsDir, 'checkpoint-summary.txt'), `${summaryLines.join('\n')}\n`);

    process.stdout.write(`${summaryLines.join('\n')}\n`);
    process.stdout.write(
      `artifacts: ${artifactsDir}/checkpoint-report.json, checkpoint-summary.txt\n`,
    );

    if (updateInventory) {
      if (!verdict.ok) {
        process.stderr.write(
          'web checkpoint: refusing to regenerate the inventory from a run that is not fully green and complete\n',
        );
        process.exitCode = 1;
        return;
      }
      writeFileSync(INVENTORY_PATH, serializeInventory(verdict.cases.map((entry) => entry.id)));
      process.stdout.write(
        `web checkpoint: inventory regenerated at ${INVENTORY_PATH} (${verdict.cases.length} cases)\n`,
      );
      return;
    }

    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// The self-tests import this module; only a direct run drives the battery.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
