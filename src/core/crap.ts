import type { FunctionComplexity } from './complexity';

/**
 * The risk math on top of the CC engine (wayfinder #55): the istanbul join,
 * the CRAP score, Uncle Bob's bands, and the baseline ratchet that gates
 * preflight. Pure functions only — file walking, git, and report rendering
 * live in `scripts/crap.mjs`.
 *
 * Metric honesty is the load-bearing rule: full CRAP (CC² × (1−coverage)³ +
 * CC, per crap4clj/PHPUnit) is computed only where per-function coverage is
 * real — `src/core`, covered by unit tests through vitest's istanbul-format
 * JSON. `src/node` and `src/client` land on a CC-only watchlist: their truth
 * is e2e coverage, which stays fog on the map. A watchlist row has
 * `coverage === null` and `crap === null`, and its gate metric is CC.
 *
 * Per-function coverage is derived from istanbul statement counters inside
 * the function's line range (the technique both CRAP tools verified during
 * the engine research use — v8-derived `fnMap` names anonymous functions
 * lossily, so names never join; ranges do). A `src/core` file absent from
 * the coverage JSON was never loaded by a test and reads as 0%.
 *
 * The ratchet: `crap-baseline.json` grandfathers the gate-metric value of
 * functions that already violate a hard stop (calibration recorded them
 * once). Preflight fails only for new violators or functions made worse than
 * their grandfathered value; `mergeBaseline` refuses to add or raise
 * entries, so the baseline only ever tightens.
 */

/** Istanbul-format `coverage-final.json` as vitest's v8 provider emits it. */
export interface IstanbulFileCoverage {
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number>;
}
export type IstanbulCoverage = Record<string, IstanbulFileCoverage>;

/** One scored function: CC plus, where honest, coverage and CRAP. */
export interface RiskEntry extends FunctionComplexity {
  file: string;
  /** The band of the gate metric (Uncle Bob: ≤5 low, <30 moderate, else high). */
  band: 'low' | 'moderate' | 'high';
  /** The metric preflight gates on for this row: CRAP for src/core, CC elsewhere. */
  metric: 'crap' | 'cc';
  /** The gate metric's value — `cc` for watchlist rows, `crap` for covered rows. */
  value: number;
  coverage: number | null;
  crap: number | null;
}

export interface GateStops {
  /** Hard stop: CRAP ≥ this in src/core. */
  coreCrapStop: number;
  /** Hard stop: CC ≥ this in src/node + src/client (complexity-only proxy). */
  watchlistCcStop: number;
}

/** Stops as calibrated 2026-08-28 (wayfinder #55); tighten, never loosen. */
export const GATE_STOPS: GateStops = { coreCrapStop: 30, watchlistCcStop: 15 };

/** Pre-commit warning level: CC ≥ this in staged functions (warn, never block). */
export const PRECOMMIT_CC_WARN = 10;

/** Uncle Bob's bands, applied to the gate metric (CRAP where real, else CC). */
export function bandOf(value: number): RiskEntry['band'] {
  if (value <= 5) return 'low';
  if (value < 30) return 'moderate';
  return 'high';
}

export function crapScore(cc: number, coverage: number): number {
  return cc * cc * (1 - coverage) ** 3 + cc;
}

/** Statement coverage inside the function's line range; a file the tests never loaded reads as 0. */
export function coverageWithin(
  fn: Pick<FunctionComplexity, 'lineStart' | 'lineEnd'>,
  fileCoverage: IstanbulFileCoverage | undefined,
): number {
  if (fileCoverage === undefined) return 0;
  let total = 0;
  let covered = 0;
  for (const [id, loc] of Object.entries(fileCoverage.statementMap)) {
    if (loc.start.line < fn.lineStart || loc.start.line > fn.lineEnd) continue;
    total += 1;
    if ((fileCoverage.s[id] ?? 0) > 0) covered += 1;
  }
  return total === 0 ? 0 : covered / total;
}

/** Functions whose line range intersects any touched range (a diff hunk's new-line span). */
export function touchedFunctions(
  fns: FunctionComplexity[],
  touchedRanges: Array<[startLine: number, endLine: number]>,
): FunctionComplexity[] {
  return fns.filter((fn) =>
    touchedRanges.some(([start, end]) => fn.lineStart <= end && fn.lineEnd >= start),
  );
}

/**
 * Baseline identity of a function. Named functions key on `file#name` —
 * tolerant of moves and line churn. Anonymous ones are position-pinned
 * (`file#(anonymous)@L<lineStart>`): a fresh anonymous violator must not
 * ride a sibling's pin, and a moved anonymous violator re-keys and re-fails
 * — the attention an unnamed stop-breaching function deserves.
 */
export function baselineKey(file: string, name: string, lineStart: number): string {
  return name === '(anonymous)' ? `${file}#${name}@L${lineStart}` : `${file}#${name}`;
}

/**
 * Splits entries into gate verdicts against the stops and the ratchet
 * baseline: `violations` fail preflight (new or made worse),
 * `grandfathered` ride their calibrated baseline entry, `improved` are
 * grandfathered functions now scoring below their entry (run
 * `--update-baseline` to tighten them away).
 */
export function evaluateGate(
  entries: RiskEntry[],
  baseline: Record<string, number>,
  stops: GateStops = GATE_STOPS,
): { violations: RiskEntry[]; grandfathered: RiskEntry[]; improved: RiskEntry[] } {
  const violations: RiskEntry[] = [];
  const grandfathered: RiskEntry[] = [];
  const improved: RiskEntry[] = [];

  for (const entry of entries) {
    const stop = entry.metric === 'crap' ? stops.coreCrapStop : stops.watchlistCcStop;
    if (entry.value < stop) continue;
    const pinned = baseline[baselineKey(entry.file, entry.name, entry.lineStart)];
    if (pinned === undefined) violations.push(entry);
    else if (entry.value > pinned) violations.push(entry);
    else if (entry.value < pinned) improved.push(entry);
    else grandfathered.push(entry);
  }

  return { violations, grandfathered, improved };
}

/**
 * Ratchet merge of the baseline against a fresh full report: surviving
 * violators keep `min(previous, current)`, recovered functions drop out,
 * and a violator with no prior entry lands in `refused` — the baseline only
 * tightens, so new violations must be refactored, never recorded.
 */
export function mergeBaseline(
  previous: Record<string, number>,
  entries: RiskEntry[],
  stops: GateStops = GATE_STOPS,
): { next: Record<string, number>; refused: RiskEntry[] } {
  const next: Record<string, number> = {};
  const refused: RiskEntry[] = [];

  for (const entry of entries) {
    const stop = entry.metric === 'crap' ? stops.coreCrapStop : stops.watchlistCcStop;
    if (entry.value < stop) continue;
    const key = baselineKey(entry.file, entry.name, entry.lineStart);
    const pinned = previous[key];
    if (pinned === undefined) {
      refused.push(entry);
      continue;
    }
    next[key] = Math.min(pinned, entry.value);
  }

  return { next, refused };
}
