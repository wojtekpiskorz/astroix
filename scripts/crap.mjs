#!/usr/bin/env bun
/**
 * crap4ts — the repo's risk report over the in-house CC engine (engine:
 * wayfinder #54; wiring: #55). One tool, five modes:
 *
 *   bun run crap                full report: CC everywhere, CRAP + Uncle Bob
 *                               bands where coverage is real (src/core)
 *   bun run crap --staged       pre-commit scan: CC warn (>= 10) on functions
 *                               touched by staged changes — warns, never blocks
 *   bun run preflight           hard stop over the PR diff scope (merge-base
 *                               vs main): CRAP >= 30 in src/core, CC >= 15 in
 *                               src/node + src/client, baseline-ratcheted
 *   bun run crap:ci             CI recompute: full table to crap-table.md for
 *                               the advisory reviewer prompt; never exits nonzero
 *   bun run crap --calibrate    one-time: pin current violators as the initial
 *                               baseline (refuses if one already exists)
 *   bun run crap --update-baseline  ratchet the baseline after refactors:
 *                               tightens and drops only, refuses new violators
 *
 * Metric honesty: CRAP (CC² × (1−cov)³ + CC) only where per-function coverage
 * is real (src/core, unit-tested); src/node and src/client are a CC watchlist.
 * The pure math lives in src/core/{complexity,crap}.ts; this file owns IO:
 * files, git, vitest coverage, rendering, exit codes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeComplexity } from '../src/core/complexity.ts';
import {
  baselineKey,
  evaluateGate,
  GATE_STOPS,
  isCoreFile,
  mergeBaseline,
  PRECOMMIT_CC_WARN,
  toRiskEntry,
  touchedFunctions,
} from '../src/core/crap.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'crap-baseline.json');
const COVERAGE_JSON = join(ROOT, 'coverage', 'coverage-final.json');

// ——— git plumbing ———

function gitOk(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** New-line spans of a unified=0 diff, as [startLine, endLine] in the new file. */
function hunkRanges(diffOutput) {
  const ranges = [];
  for (const m of diffOutput.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

function mergeBaseSha() {
  for (const ref of ['origin/main', 'main']) {
    const base = gitOk(['merge-base', 'HEAD', ref]);
    if (base !== null) return { base: base.trim(), ref };
  }
  throw new Error('no merge-base against origin/main or main — run preflight on a branch off main');
}

/** Risk scope: product TS/TSX under src/ — test bodies are the coverage, not the risk. */
function isRiskScope(relPath) {
  return (
    relPath.startsWith('src/') &&
    (relPath.endsWith('.ts') || relPath.endsWith('.tsx')) &&
    !relPath.endsWith('.test.ts') &&
    !relPath.endsWith('.test.tsx') &&
    !relPath.endsWith('.d.ts')
  );
}

/** Files in risk scope named by a diff (ACMR: added/copied/modified/renamed). */
function diffScopedFiles(gitArgs) {
  const out = gitOk(['diff', '--name-only', '--diff-filter=ACMR', '-z', ...gitArgs]) ?? '';
  return out
    .split('\0')
    .filter((p) => p.length > 0)
    .filter(isRiskScope)
    .map((p) => join(ROOT, p));
}

const changedFiles = (base) => diffScopedFiles([base, 'HEAD']);
const stagedFiles = () => diffScopedFiles(['--cached']);

/** Function content as committed at HEAD — preflight evaluates the committed state, never a dirty tree. */
const committedSource = (abs) => gitOk(['show', `HEAD:${relative(ROOT, abs)}`]) ?? '';

// ——— analysis ———

function walkTs(dir = SRC_ROOT) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out.filter((p) => isRiskScope(relative(ROOT, p)));
}

function analyzeFile(abs, source) {
  const file = relative(ROOT, abs);
  const fns = analyzeComplexity(source, file); // throws SyntaxError on parse failure
  return { file, fns };
}

/** CC + (where honest) coverage/CRAP for every function in the given files. */
function buildEntries(files, coverage, read = (abs) => readFileSync(abs, 'utf8')) {
  const entries = [];
  for (const abs of files) {
    const { file, fns } = analyzeFile(abs, read(abs));
    for (const fn of fns)
      entries.push(toRiskEntry(file, fn, coverage === null ? null : coverage?.[abs]));
  }
  return entries;
}

const touchedId = (file, fn) => `${file}#${fn.name}@L${fn.lineStart}`;

/** Touched function identities across changed files, via the tested touchedFunctions helper. */
function touchedKeys(files, base, read) {
  const touched = new Set();
  for (const abs of files) {
    const file = relative(ROOT, abs);
    const { fns } = analyzeFile(abs, read(abs));
    const ranges = hunkRanges(gitOk(['diff', '--unified=0', base, 'HEAD', '--', file]) ?? '');
    for (const fn of touchedFunctions(fns, ranges)) touched.add(touchedId(file, fn));
  }
  return touched;
}

/**
 * Runs vitest with coverage. `hard: false` (CI table, local report) degrades
 * to null on a red suite — those outputs must never gate anything, and a
 * CC-only table beats no review at all. The gates (preflight, baseline
 * modes) stay hard: untrustworthy CRAP must not pass or pin.
 */
function runCoverage({ hard = true } = {}) {
  const r = spawnSync('bun', ['x', 'vitest', 'run', '--coverage'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    if (!hard) {
      console.error('crap: vitest coverage run failed — degrading to a CC-only table');
      return null;
    }
    console.error('crap: vitest coverage run failed — the CRAP term needs it');
    process.exit(1);
  }
  return JSON.parse(readFileSync(COVERAGE_JSON, 'utf8'));
}

function readBaseline() {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
}

// ——— rendering ———

const pct = (cov) => (cov === null ? '  —  ' : `${String(Math.round(cov * 100)).padStart(3)}%`);
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function renderTable(entries) {
  const rows = entries
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((e) =>
      [
        e.file.padEnd(28),
        `${e.name}@L${e.lineStart}`.padEnd(28),
        `cc ${String(e.cc).padStart(3)}`,
        `cov ${pct(e.coverage)}`,
        `crap ${e.crap === null ? '  —' : num(e.crap).padStart(5)}`,
        e.band.padEnd(8),
      ].join('  '),
    );
  return rows.join('\n');
}

function headerLine() {
  return `stops: CRAP >= ${GATE_STOPS.coreCrapStop} (src/core) · CC >= ${GATE_STOPS.watchlistCcStop} (src/node, src/client) · pre-commit warns CC >= ${PRECOMMIT_CC_WARN}`;
}

// ——— modes ———

function modeReport() {
  const coverage = runCoverage({ hard: false });
  const entries = buildEntries(walkTs(), coverage);
  const baseline = readBaseline();
  const { violations, grandfathered, improved } = evaluateGate(entries, baseline);

  console.log(
    `\ncrap4ts report — ${entries.length} functions, bands: <=5 low · <30 moderate · >=30 high`,
  );
  console.log(headerLine());
  console.log(`\n${renderTable(entries)}`);

  if (violations.length > 0) {
    console.log(`\nNEW violations (preflight would fail these):`);
    for (const v of violations)
      console.log(`  ${v.file} ${v.name}: ${v.metric} ${num(v.value)} >= ${v.stop}`);
  }
  if (grandfathered.length > 0) {
    console.log(`\ngrandfathered (baseline, only tighten):`);
    for (const g of grandfathered)
      console.log(
        `  ${g.file} ${g.name}: ${g.metric} ${num(g.value)} (pinned ${baseline[baselineKey(g.file, g.name, g.lineStart)]})`,
      );
  }
  if (improved.length > 0) {
    console.log(
      `\nimproved below their baseline pin — tighten with \`bun run crap --update-baseline\`:`,
    );
    for (const i of improved)
      console.log(
        `  ${i.file} ${i.name}: ${i.metric} ${num(i.value)} (pinned ${baseline[baselineKey(i.file, i.name, i.lineStart)]})`,
      );
  }
  if (violations.length === 0 && grandfathered.length === 0 && improved.length === 0)
    console.log('\nno function breaches its stop — baseline is empty-eligible');
}

function modeStaged() {
  const files = stagedFiles();
  let warned = 0;
  for (const abs of files) {
    const file = relative(ROOT, abs);
    const stagedSource = gitOk(['show', `:${file}`]);
    if (stagedSource === null) continue;
    let fns;
    try {
      fns = analyzeComplexity(stagedSource, file);
    } catch (e) {
      console.error(`astroix pre-commit: skipping ${file} (${e.message})`);
      continue;
    }
    const ranges = hunkRanges(gitOk(['diff', '--cached', '--unified=0', '--', file]) ?? '');
    for (const fn of touchedFunctions(fns, ranges)) {
      if (fn.cc >= PRECOMMIT_CC_WARN) {
        console.warn(
          `astroix pre-commit: ${file} ${fn.name}@L${fn.lineStart} cc ${fn.cc} >= ${PRECOMMIT_CC_WARN} — consider splitting before it grows`,
        );
        warned += 1;
      }
    }
  }
  if (warned === 0) console.log('astroix pre-commit: staged CC scan clean');
}

function modePreflight() {
  const { base, ref } = mergeBaseSha();
  const files = changedFiles(base);
  if (files.length === 0) {
    console.log('preflight: no src changes vs merge-base — CRAP scope empty');
    return;
  }
  if ((gitOk(['status', '--porcelain']) ?? '').length > 0)
    console.log('preflight: evaluating committed state (HEAD); working tree is dirty');

  const uniqueFiles = [...new Set(files)];
  // one analysis pass over the changed files: touched set first, so a diff
  // landing between functions never pays the coverage run
  const touched = [];
  for (const abs of uniqueFiles) {
    const file = relative(ROOT, abs);
    const { fns } = analyzeFile(abs, committedSource(abs));
    const ranges = hunkRanges(gitOk(['diff', '--unified=0', base, 'HEAD', '--', file]) ?? '');
    for (const fn of touchedFunctions(fns, ranges)) touched.push({ file, fn });
  }
  if (touched.length === 0) {
    console.log(`preflight: ${uniqueFiles.length} changed file(s), no function touched — pass`);
    return;
  }

  const needCoverage = uniqueFiles.some((f) => isCoreFile(relative(ROOT, f)));
  const coverage = needCoverage ? runCoverage() : {};
  const entries = touched.map(({ file, fn }) =>
    toRiskEntry(file, fn, coverage === null ? null : coverage?.[join(ROOT, file)]),
  );
  const baseline = readBaseline();
  const { violations, grandfathered, improved } = evaluateGate(entries, baseline);

  console.log(`\npreflight — CRAP hard stop over ${entries.length} touched function(s) vs ${ref}`);
  console.log(headerLine());
  console.log(`\n${renderTable(entries)}`);
  for (const g of grandfathered)
    console.log(`grandfathered: ${g.file} ${g.name} (${g.metric} ${num(g.value)})`);
  for (const i of improved)
    console.log(
      `improved: ${i.file} ${i.name} ${num(i.value)} < pin ${baseline[baselineKey(i.file, i.name, i.lineStart)]} — tighten the baseline`,
    );

  if (violations.length > 0) {
    console.error(`\npreflight FAIL — ${violations.length} violation(s):`);
    for (const v of violations)
      console.error(
        `  ${v.file} ${v.name}@L${v.lineStart}: ${v.metric} ${num(v.value)} >= ${v.stop} (refactor, or split the function)`,
      );
    process.exit(1);
  }
  console.log('\npreflight pass');
}

function modeCi() {
  const envBase = process.env.GITHUB_BASE_SHA;
  // pull_request.base.sha is the PR-object snapshot, not the live base tip:
  // canonicalize through merge-base or advancing main reads as PR-made changes
  const base =
    envBase === undefined ? undefined : (gitOk(['merge-base', envBase, 'HEAD']) ?? envBase).trim();
  const coverage = runCoverage({ hard: false });
  const entries = buildEntries(walkTs(), coverage);

  const touched =
    base === undefined
      ? new Set()
      : touchedKeys([...new Set(changedFiles(base))], base, committedSource);
  const isTouched = (e) => touched.has(touchedId(e.file, e));

  const baseline = readBaseline();
  const { violations, grandfathered } = evaluateGate(entries, baseline);
  const sorted = entries.slice().sort((a, b) => b.value - a.value);

  const lines = [];
  lines.push('# crap4ts report (recomputed by CI — the source of truth; local runs are advisory)');
  lines.push('');
  lines.push(
    `CC per function (ESLint-classic counting, pinned in \`src/core/complexity.test.ts\`); CRAP = CC² × (1−cov)³ + CC where per-function coverage is real (\`src/core\`, unit tests); \`src/node\` + \`src/client\` are a CC-only watchlist (their truth is e2e coverage). Uncle Bob bands: <=5 low, <30 moderate, >=30 high.`,
  );
  if (coverage === null)
    lines.push(
      '',
      '> **DEGRADED**: the vitest coverage run failed — this is a CC-only table with no CRAP column. The deterministic gates own the red suite; this table is what the review gets anyway.',
    );
  lines.push('');
  lines.push(
    `Hard stops (preflight, baseline-ratcheted): CRAP >= ${GATE_STOPS.coreCrapStop} (src/core) · CC >= ${GATE_STOPS.watchlistCcStop} (src/node, src/client). Pre-commit warns at CC >= ${PRECOMMIT_CC_WARN}.`,
  );
  lines.push('');
  lines.push('| file | function | cc | cov | crap | band | in-PR |');
  lines.push('|---|---|---:|---:|---:|---|:-:|');
  for (const e of sorted)
    lines.push(
      `| ${e.file} | ${e.name}@L${e.lineStart} | ${e.cc} | ${e.coverage === null ? '—' : `${Math.round(e.coverage * 100)}%`} | ${e.crap === null ? '—' : num(e.crap)} | ${e.band} | ${isTouched(e) ? '✓' : ''} |`,
    );
  lines.push('');
  if (violations.length > 0) {
    lines.push(
      `## Stop breaches (new or regressed — preflight fails these when the PR touches them)`,
    );
    for (const v of violations)
      lines.push(
        `- ${v.file} ${v.name}@L${v.lineStart}: ${v.metric} ${num(v.value)} (stop ${v.stop})`,
      );
    lines.push('');
  }
  if (grandfathered.length > 0) {
    lines.push(`## Grandfathered (calibrated baseline — known debt, only ratchets down)`);
    for (const g of grandfathered)
      lines.push(
        `- ${g.file} ${g.name}@L${g.lineStart}: ${g.metric} ${num(g.value)} (pinned ${baseline[baselineKey(g.file, g.name, g.lineStart)]})`,
      );
    lines.push('');
  }
  lines.push(
    `Baseline: \`${relative(ROOT, BASELINE_PATH)}\` — entries tighten or drop via \`bun run crap --update-baseline\`, never grow.`,
  );

  writeFileSync(join(ROOT, 'crap-table.md'), `${lines.join('\n')}\n`);
  console.log(
    `crap:ci wrote ${entries.length}-function table to crap-table.md (${violations.length} breach(es), ${grandfathered.length} grandfathered)`,
  );
}

function modeCalibrate() {
  if (existsSync(BASELINE_PATH)) {
    console.error(
      'calibrate: crap-baseline.json already exists — calibration happens once; from here the ratchet only tightens (bun run crap --update-baseline)',
    );
    process.exit(1);
  }
  const coverage = runCoverage();
  const entries = buildEntries(walkTs(), coverage);
  const { violations } = evaluateGate(entries, {});
  const next = {};
  for (const v of violations) next[baselineKey(v.file, v.name, v.lineStart)] = v.value;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sortKeys(next), null, 2)}\n`);
  console.log(
    `calibrated ${Object.keys(next).length} baseline entr${Object.keys(next).length === 1 ? 'y' : 'ies'} (one-time act; from here only --update-baseline, which never adds):`,
  );
  for (const [k, v] of Object.entries(next)) console.log(`  ${k} = ${v}`);
}

function modeUpdateBaseline() {
  const coverage = runCoverage();
  const entries = buildEntries(walkTs(), coverage);
  const previous = readBaseline();
  const { next, refused } = mergeBaseline(previous, entries);

  if (refused.length > 0) {
    console.error(
      'baseline update REFUSED — the ratchet never adds entries; refactor these instead:',
    );
    for (const r of refused) console.error(`  ${r.file} ${r.name}: ${r.metric} ${num(r.value)}`);
    process.exit(1);
  }

  writeFileSync(BASELINE_PATH, `${JSON.stringify(sortKeys(next), null, 2)}\n`);
  const kept = Object.keys(next).length;
  const dropped = Object.keys(previous).filter((k) => next[k] === undefined);
  const tightened = Object.keys(next).filter(
    (k) => previous[k] !== undefined && next[k] < previous[k],
  );
  console.log(`baseline: ${kept} kept, ${dropped.length} dropped, ${tightened.length} tightened`);
  for (const k of dropped) console.log(`  dropped ${k} (recovered below its stop)`);
  for (const k of tightened) console.log(`  tightened ${k}: ${previous[k]} -> ${next[k]}`);
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ——— entry ———

const mode = process.argv[2] ?? '';
switch (mode) {
  case '':
    modeReport();
    break;
  case '--staged':
    modeStaged();
    break;
  case '--preflight':
    modePreflight();
    break;
  case '--ci':
    modeCi();
    break;
  case '--calibrate':
    modeCalibrate();
    break;
  case '--update-baseline':
    modeUpdateBaseline();
    break;
  default:
    console.error(
      `crap: unknown mode "${mode}" (use --staged | --preflight | --ci | --calibrate | --update-baseline)`,
    );
    process.exit(2);
}
