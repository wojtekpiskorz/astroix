import type { FunctionComplexity } from './complexity';

/**
 * The risk math on top of the CC engine (wayfinder #55): the istanbul join,
 * the CRAP score, Uncle Bob's bands, and the baseline ratchet that gates
 * preflight. Pure functions only — file walking, git, and report rendering
 * live in `scripts/crap.mjs`.
 *
 * This file and `complexity.ts` are the CRAP tooling layer, not
 * editing-domain code: they stayed at `src/core` when the editing modules
 * moved to `packages/core` (#212, AC-6) and are owned by this layer plus
 * `scripts/crap.mjs`.
 *
 * Metric honesty is the load-bearing rule: full CRAP (CC² × (1−coverage)³ +
 * CC, per crap4clj/PHPUnit) is computed only where per-function coverage
 * is real — the covered core tier (`packages/core` since #212,
 * `packages/protocol` since #220, the `src/core` CRAP tooling
 * layer, `packages/runtime/registry` since #221, and the
 * `packages/runtime/{kernel-lease,private-boot}` boot-authority seams
 * since #222 and the AstroProjectAdapter's pure seams since #225 — all
 * deterministic real-filesystem unit tests over temp directories and
 * real temp SQLite lease files), the styles join's pure seams since #226
 * (correspondence join + source walk, deterministic units), covered by
 * unit
 * tests through
 * vitest's istanbul-format JSON. The UI foundation package
 * `packages/app-shell` (#218 — its truth is e2e coverage, not
 * per-function unit tests), the adapter's composition IO seam (#225 —
 * its truth is the real-install certification suite), and the styles
 * join's client-environment IO composition (#226, same truth) land on a
 * CC-only
 * watchlist; later
 * `packages/runtime` seams beyond the ruled ones decide their own tier in
 * the lane that lands them. The styles convergence seams since #227
 * (parity classifier + revisioned invalidation source) join the covered
 * tier; its converged-inspection IO composition is watchlist like the
 * join's (#227). The project-plane worker seams since #230 (dispatch/
 * revision/invalidation/cleanup state machine + typed contracts + the
 * IPC serving loop) join the covered tier; the real IO glue
 * (composition-runtime.ts, worker-child.ts) is watchlist like the
 * adapter's composition (#230). The plane supervision + managed-astro
 * seams since #231 — the exact-child spawn discipline, the minimal
 * child environment, the close-report classifier, and the managed
 * dev-server spawn plan — are covered; their real process IO
 * (plane-supervisor.ts, the dev-server readiness probe) is watchlist
 * like the plane's other IO glue (#231). The project-runtime facade
 * seams since #232 — the start/ready/inspect/subscribe/stop sequencing
 * and redaction state machine plus the declared proxy-health
 * prerequisite — are covered (deterministic units over supervisor/wire
 * fakes); the production launch composition (plane-launch.ts — real
 * spawn plans, real children via the supervisor) is watchlist like the
 * plane's other IO glue (#232). The origin/proxy seams since #233 (F1)
 * split the same way: the virtual-host vocabulary and Host/target
 * classification, the routing state machine, and the upgrade admission
 * + handshake reconstruction are covered; the listener composition, the
 * HTTP stream proxy, the raw upgrade tunnel, and the proxy-health
 * prober are watchlist (#233). The HTTP API v1 seams since #234 (F2)
 * split the same way: the dispatch core, the command permission matrix,
 * the security-header evidence, the host-capability grants, the
 * client-binding table, the authority strip, the bounded envelope
 * validation, and the sanitized error responses are covered
 * (deterministic pure units); the reserved-handler socket composition
 * is watchlist like the plane's other IO glue (#234). The
 * session-supervisor staging + client seams since #236 (F4) — the
 * staged activation state machine (generation reservation, private
 * candidate readiness, rollback, the commit linearization's state side,
 * crash observation) and the document-bound client registry (one
 * editor, three diagnostics, navigation/renderer/session revocation,
 * the menu-action currency envelope) — are covered (deterministic
 * units over run fakes); the fence (F5) and commit/revocation (F6)
 * subtrees rule their own tiers when their lanes land. A
 * watchlist row has `coverage === null` and `crap === null`, and its gate
 * metric is CC. (The `src/node` + `src/client` watchlist tiers were
 * deleted with their functions at the retirement gate, #215.)
 *
 * Per-function coverage is derived from istanbul statement counters inside
 * the function's line range (the technique both CRAP tools verified during
 * the engine research use — v8-derived `fnMap` names anonymous functions
 * lossily, so names never join; ranges do). A covered-tier file absent from
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
  /** The metric preflight gates on for this row: CRAP for the covered core tier, CC elsewhere. */
  metric: 'crap' | 'cc';
  /** The gate metric's value — `cc` for watchlist rows, `crap` for covered rows. */
  value: number;
  /** The hard stop this row is gated against, derived with its metric in toRiskEntry. */
  stop: number;
  /** The generated tier (shadcn `components/ui/` under `packages/app-shell/src/`): visible, never gated (stop is Infinity). */
  watchOnly: boolean;
  coverage: number | null;
  crap: number | null;
}

export interface GateStops {
  /** Hard stop: CRAP ≥ this in the covered core tier (src/core, packages/core, packages/protocol). */
  coreCrapStop: number;
  /** Hard stop: CC ≥ this in the CC-only watchlist (packages/app-shell — complexity-only proxy). */
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

// ——— the covered-tier dispatch, as data (#311) ———
// Each lane's tier decision is one entry below, never another clause in a
// boolean: a covered tree adds a prefix, an IO-composition file whose
// truth is a certification suite or a process lane (not unit fakes) adds
// an exact path to the watchlist exceptions, an evidence subtree adds a
// watchlist prefix. The per-lane history rides beside its entries.

/**
 * Trees where per-function unit coverage is real — CRAP's only honest
 * home. Everything else under the risk roots is a CC-only watchlist row.
 */
const COVERED_PREFIXES: readonly string[] = [
  // `src/core` — this tooling layer itself, unit-covered (it stayed here
  // when the editing modules moved to packages/core, #212; the
  // compatibility shims died at the retirement gate, #215).
  'src/core/',
  // `packages/core` since #212 and `packages/protocol` since #220: pure
  // modules with colocated unit tests.
  'packages/core/',
  'packages/protocol/',
  // `packages/runtime/registry` since #221: deterministic real-filesystem
  // unit tests over temp directories.
  'packages/runtime/registry/',
  // `packages/runtime/{kernel-lease,private-boot}` since #222: the
  // boot-authority seams — deterministic unit tests over real temp SQLite
  // lease files and a real in-memory private-IPC channel, with the forked
  // process lanes asserting the cross-process semantics on the same
  // modules.
  'packages/runtime/kernel-lease/',
  'packages/runtime/private-boot/',
  // `packages/runtime/edit-authority` — the grant/planning seams since
  // #223 (pure grant lifecycle and planning logic over real temp roots,
  // the registry seam's covered-tier decision) and the executor since
  // #224 (the serialized write discipline, same deterministic-units
  // ruling).
  'packages/runtime/edit-authority/',
  // `packages/runtime/project-plane` since #230/#231: the worker seams —
  // the dispatch/revision/invalidation/cleanup state machine, the typed
  // contracts, and the IPC serving loop (deterministic units over
  // dispatch-boundary fakes + real forked children, the #222 process-lane
  // idiom) — plus the supervision/managed-astro pure decision logic
  // (exact-child spawn plans, the minimal child environment, the
  // close-report classifier, the managed dev-server spawn plan).
  'packages/runtime/project-plane/',
  // `packages/runtime/project-runtime` since #232: the facade's pure
  // sequencing/redaction layer over the injected launch + health seams
  // and the declared proxy-health prerequisite (deterministic units over
  // supervisor/wire fakes).
  'packages/runtime/project-runtime/',
  // `packages/runtime/{origin,proxy}` since #233 (F1): the virtual-host
  // vocabulary and Host/target classification, the routing grant/revoke
  // state machine, and the upgrade admission + handshake reconstruction —
  // deterministic pure units; the real socket IO is watchlisted below.
  'packages/runtime/origin/',
  'packages/runtime/proxy/',
  // `packages/runtime/api` since #234 (F2): the HTTP API v1 pure seams —
  // the dispatch core, the command permission matrix, the
  // security-header evidence, the host-capability grants, the
  // client-binding table, the authority strip, the bounded envelope
  // validation, and the sanitized error responses — deterministic pure
  // units; the reserved-handler socket composition is watchlisted below.
  // #235 (F3) added the bounded pagination seams under the same tree
  // (api/pagination — the page math and the protocol-typed page
  // builders, deterministic pure units over the envelopeBytes idiom).
  'packages/runtime/api/http/',
  'packages/runtime/api/errors/',
  'packages/runtime/api/pagination/',
  // `packages/runtime/sse` since #235 (F3): the SSE pure seams — the
  // admission core (route/Host/capability/Origin/Fetch-Metadata/binding/
  // role/SessionRef laws over the same F2 spine, imported read-only),
  // the stream hub (caps, delivery matrix, generation watermark,
  // revocation scopes — deterministic units over recorder sinks), and
  // the frame writer (cap enforcement at the transport); the events
  // surface socket composition is watchlisted below.
  'packages/runtime/sse/',
  // `packages/runtime/astro-project-adapter` since #225: the pure seams —
  // pair gate, resolution, seam probes, runner accounting (#225), the
  // styles join's correspondence join + source walk (#226), the
  // convergence parity classifier + revisioned invalidation source
  // (#227), the content inspection seams (#228), and the routes
  // inspection seams (#229) — deterministic unit tests with
  // resolution-layer stubs.
  'packages/runtime/astro-project-adapter/',
  // `packages/runtime/session-supervisor/{staging,clients}` since #236
  // (F4): the staged activation state machine (runtime epochs, generation
  // reservation, private candidate readiness, rollback, the commit
  // linearization's state side, crash observation) and the
  // document-bound client registry (the authoritative-editor/diagnostic
  // role caps, navigation/renderer/session revocation, the menu-action
  // currency envelope) — deterministic units over run fakes. The fence
  // (F5 #237) and commit/revocation (F6 #238) subtrees under
  // session-supervisor/ stay watchlist until their lanes rule.
  'packages/runtime/session-supervisor/staging/',
  'packages/runtime/session-supervisor/clients/',
];

/**
 * Watchlist exception files under a covered prefix: real IO composition
 * whose behavioral truth is a certification suite or a process lane, not
 * unit fakes at the behavior layer — CC-only rows (metric honesty).
 */
const WATCHLIST_EXCEPTION_FILES: ReadonlySet<string> = new Set([
  // #225: the adapter's IO seam — its truth is the real-install
  // certification suite (`npm run certify:adapter`).
  'packages/runtime/astro-project-adapter/composition.ts',
  // #226: the styles join's client-environment IO composition — same
  // truth as composition.ts (route-styles.ts stays the join's internal
  // leg).
  'packages/runtime/astro-project-adapter/styles/join/client-scoped-css.ts',
  'packages/runtime/astro-project-adapter/styles/join/route-styles.ts',
  // #227: the converged-styles inspection's IO composition — watchlist
  // for the same reason as the join's.
  'packages/runtime/astro-project-adapter/styles/convergence/converged-styles-inspection.ts',
  // #230: the plane's real IO glue — composition-runtime.ts boots the
  // adapter's composition server, worker-child.ts is the forked entry;
  // their truth is the certification suite and the packaged runtime.
  'packages/runtime/project-plane/composition/composition-runtime.ts',
  'packages/runtime/project-plane/worker/worker-child.ts',
  // #231: the real process IO — plane-supervisor.ts spawns, signals, and
  // reaps; dev-server.ts probes the managed dev server's readiness.
  'packages/runtime/project-plane/supervision/plane-supervisor.ts',
  'packages/runtime/project-plane/managed-astro/dev-server.ts',
  // #232: the production launch composition — canonical-root resolution,
  // the project's own astro CLI lookup, real children through the
  // supervisor; its truth is the supervision process lane.
  'packages/runtime/project-runtime/plane-launch.ts',
  // #233 (F1): the real socket IO — the listener composition (binds the
  // loopback server, tracks and revokes sockets), the HTTP stream proxy,
  // the raw upgrade tunnel, and the proxy-health prober; their truth is
  // the real-socket focused lane (test/proxy, loopback stand-in
  // upstreams, OS-assigned ports).
  'packages/runtime/origin/origin-listener.ts',
  'packages/runtime/proxy/http-stream.ts',
  'packages/runtime/proxy/upgrade-tunnel.ts',
  'packages/runtime/proxy/proxy-health.ts',
  // #234 (F2): the API surface's real socket IO — the reserved-handler
  // composition behind F1's handleReserved hook (bounded body read,
  // response write); its truth is the real-socket focused lane
  // (test/http-api, through the REAL origin listener, OS-assigned
  // loopback ports).
  'packages/runtime/api/http/reserved-handler.ts',
  // #235 (F3): the SSE surface's real socket IO — the events-route
  // composition behind F1's handleReserved hook (SSE head, open stream
  // sink/close, fallback delegation); its truth is the real-socket
  // focused lane (test/sse, through the REAL origin listener,
  // OS-assigned loopback ports, open streams over raw sockets).
  'packages/runtime/sse/sse-surface.ts',
]);

/**
 * Watchlist exception subtrees: evidence machinery kept off the covered
 * tier wholesale.
 */
const WATCHLIST_EXCEPTION_PREFIXES: readonly string[] = [
  // #297: the certification harness — real-install evidence machinery
  // over the canonical fixture, never shipped product code (the report
  // layer already keeps it out of risk scope; this keeps the tier
  // decision true for any caller of the tier dispatch itself).
  'packages/runtime/astro-project-adapter/certification/',
];

/** The layer where per-function unit coverage is real — CRAP's only honest home. */
function isCoreFile(relPath: string): boolean {
  if (WATCHLIST_EXCEPTION_FILES.has(relPath)) return false;
  if (WATCHLIST_EXCEPTION_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
  return COVERED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** The shadcn-generated tier: regenerated per ADR-0002, never hand-edited — visible in reports, never gated (owner ruling 2026-08-28, #62). The set lives at packages/app-shell (#218); the legacy src/client prefix died with the integration at the retirement gate (#215). */
export function isWatchOnlyFile(relPath: string): boolean {
  return relPath.startsWith('packages/app-shell/src/components/ui/');
}

/**
 * The single construction point for risk rows: `metric`, `value`, `stop`,
 * `band`, `coverage` and `crap` all derive from the file's layer here and
 * nowhere else, so the value the gate reads can never disagree with the row
 * the report renders. Core rows join the istanbul coverage; watchlist rows
 * ignore it even when given (metric honesty). `fileCoverage: null` (distinct
 * from `undefined`) is the degraded mode — the coverage run itself failed —
 * and downgrades any row to a CC-only one rather than lying with 0%.
 */
export function toRiskEntry(
  file: string,
  fn: FunctionComplexity,
  fileCoverage: IstanbulFileCoverage | undefined | null,
): RiskEntry {
  const watchOnly = isWatchOnlyFile(file);
  // null (coverage run failed) degrades even core rows to CC; only a real
  // coverage object lets a core row take the CRAP metric
  if (fileCoverage !== null && isCoreFile(file)) {
    const coverage = coverageWithin(fn, fileCoverage);
    const crap = crapScore(fn.cc, coverage);
    return {
      file,
      ...fn,
      coverage,
      crap,
      metric: 'crap',
      value: crap,
      stop: GATE_STOPS.coreCrapStop, // ui/ is an app-shell prefix — never lands in the core tier
      watchOnly,
      band: bandOf(crap),
    };
  }
  return {
    file,
    ...fn,
    coverage: null,
    crap: null,
    metric: 'cc',
    value: fn.cc,
    stop: watchOnly ? Number.POSITIVE_INFINITY : GATE_STOPS.watchlistCcStop,
    watchOnly,
    band: bandOf(fn.cc),
  };
}

/**
 * Baseline identity of a function. Named functions key on `file#name` —
 * tolerant of moves and line churn. Anonymous ones are position-pinned
 * (`file#(anonymous)@L<lineStart>`): a fresh anonymous violator must not
 * ride a sibling's pin, and a moved anonymous violator re-keys and re-fails
 * — the attention an unnamed stop-breaching function deserves.
 *
 * Accepted risk: two same-named functions in one file share a pin. It takes
 * two same-named stop breaches in a single file to bite; the cheap false
 * pass is preferable to key churn on every move.
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
): { violations: RiskEntry[]; grandfathered: RiskEntry[]; improved: RiskEntry[] } {
  const violations: RiskEntry[] = [];
  const grandfathered: RiskEntry[] = [];
  const improved: RiskEntry[] = [];

  for (const entry of entries) {
    if (entry.value < entry.stop) continue;
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
): { next: Record<string, number>; refused: RiskEntry[] } {
  const next: Record<string, number> = {};
  const refused: RiskEntry[] = [];

  for (const entry of entries) {
    if (entry.value < entry.stop) continue;
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
