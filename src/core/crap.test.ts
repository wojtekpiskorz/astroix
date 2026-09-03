import { describe, expect, it } from 'vitest';
import {
  bandOf,
  baselineKey,
  coverageWithin,
  crapScore,
  evaluateGate,
  GATE_STOPS,
  type IstanbulCoverage,
  mergeBaseline,
  type RiskEntry,
  toRiskEntry,
  touchedFunctions,
} from './crap';

function entry(overrides: Partial<RiskEntry> = {}): RiskEntry {
  const merged = {
    file: 'src/core/matcher.ts',
    name: 'fn',
    lineStart: 1,
    lineEnd: 10,
    cc: 4,
    band: 'low',
    metric: 'crap',
    value: 4,
    coverage: 1,
    crap: 4,
    ...overrides,
  } as RiskEntry;
  merged.stop =
    overrides.stop ??
    (merged.metric === 'crap' ? GATE_STOPS.coreCrapStop : GATE_STOPS.watchlistCcStop);
  return merged;
}

describe('crapScore', () => {
  it('equals CC at full coverage and CC²+CC at zero coverage', () => {
    expect(crapScore(4, 1)).toBe(4);
    expect(crapScore(4, 0)).toBe(20);
  });

  it('is never below CC (the property that makes CRAP ≥ CC a CC ceiling)', () => {
    for (let cov = 0; cov <= 1; cov += 0.25) {
      expect(crapScore(6, cov)).toBeGreaterThanOrEqual(6);
    }
  });

  it('matches the research-lab numbers', () => {
    // selectorSpecificity cc=10 cov=61.29% → 15.80 (barney-media cross-check, #54)
    expect(Number(crapScore(10, 0.6129).toFixed(2))).toBe(15.8);
  });
});

describe('bandOf', () => {
  it('cuts Uncle Bob bands at 5 and 30', () => {
    expect(bandOf(1)).toBe('low');
    expect(bandOf(5)).toBe('low');
    expect(bandOf(5.1)).toBe('moderate');
    expect(bandOf(29.9)).toBe('moderate');
    expect(bandOf(30)).toBe('high');
  });
});

describe('coverageWithin', () => {
  const coverage: IstanbulCoverage = {
    '/repo/src/core/matcher.ts': {
      statementMap: {
        s0: { start: { line: 2 }, end: { line: 2 } },
        s1: { start: { line: 3 }, end: { line: 3 } },
        s2: { start: { line: 4 }, end: { line: 4 } },
        outside: { start: { line: 40 }, end: { line: 42 } },
      },
      s: { s0: 3, s1: 0, s2: 1, outside: 9 },
    },
  };

  it('joins by line range: statements starting inside the function', () => {
    expect(
      coverageWithin({ lineStart: 1, lineEnd: 10 }, coverage['/repo/src/core/matcher.ts']),
    ).toBe(2 / 3);
  });

  it('reads a file the tests never loaded as 0', () => {
    expect(coverageWithin({ lineStart: 1, lineEnd: 10 }, undefined)).toBe(0);
  });

  it('reads a function with no mapped statements as 0', () => {
    expect(
      coverageWithin({ lineStart: 20, lineEnd: 30 }, coverage['/repo/src/core/matcher.ts']),
    ).toBe(0);
  });
});

describe('touchedFunctions', () => {
  const fns = [
    { name: 'a', lineStart: 1, lineEnd: 10, cc: 1 },
    { name: 'b', lineStart: 12, lineEnd: 20, cc: 1 },
    { name: 'c', lineStart: 22, lineEnd: 30, cc: 1 },
  ];

  it('selects functions intersecting any hunk range (inclusive edges)', () => {
    expect(touchedFunctions(fns, [[5, 12]])).toEqual([fns[0], fns[1]]);
    expect(touchedFunctions(fns, [[30, 44]])).toEqual([fns[2]]);
    expect(touchedFunctions(fns, [[11, 11]])).toEqual([]);
  });
});

describe('evaluateGate', () => {
  it('flags stop-breaching functions without a baseline entry', () => {
    const hot = entry({ name: 'hot', cc: 31, value: 31, band: 'high' });
    const { violations } = evaluateGate([entry(), hot], {});
    expect(violations).toEqual([hot]);
  });

  it('grandfathers a calibrated violation at its pinned value and fails worse', () => {
    const baseline = { [baselineKey('src/node/rest.ts', 'handleApiRequest', 38)]: 27 };
    const ride = entry({
      file: 'src/node/rest.ts',
      name: 'handleApiRequest',
      metric: 'cc',
      cc: 27,
      value: 27,
      coverage: null,
      crap: null,
      band: 'high',
    });
    const worse = { ...ride, cc: 28, value: 28 };

    const riding = evaluateGate([ride], baseline);
    expect(riding.violations).toEqual([]);
    expect(riding.grandfathered).toEqual([ride]);

    const regressed = evaluateGate([worse], baseline);
    expect(regressed.violations).toEqual([worse]);
  });

  it('reports improved grandfathered entries as tighten candidates', () => {
    const baseline = { [baselineKey('src/core/matcher.ts', 'fn', 1)]: 40 };
    const better = entry({ value: 32, cc: 6, crap: 32, band: 'high' });
    const { improved } = evaluateGate([better], baseline);
    expect(improved).toEqual([better]);
  });

  it('position-pins anonymous keys so a fresh anonymous violator cannot ride a sibling pin', () => {
    expect(baselineKey('src/client/app.tsx', '(anonymous)', 12)).toBe(
      'src/client/app.tsx#(anonymous)@L12',
    );
    expect(baselineKey('src/client/app.tsx', 'RuleList', 12)).toBe('src/client/app.tsx#RuleList');

    const pinned = { [baselineKey('src/client/app.tsx', '(anonymous)', 12)]: 27 };
    const sibling = entry({
      file: 'src/client/app.tsx',
      name: '(anonymous)',
      lineStart: 30,
      lineEnd: 40,
      metric: 'cc',
      cc: 20,
      value: 20,
      coverage: null,
      crap: null,
      band: 'moderate',
    });
    expect(evaluateGate([sibling], pinned).violations).toEqual([sibling]);
  });

  it('gates watchlist rows on CC with the cc stop, core rows on CRAP', () => {
    const watchCold = entry({
      file: 'src/client/editor.tsx',
      metric: 'cc',
      cc: 14,
      value: 14,
      coverage: null,
      crap: null,
    });
    const watchHot = entry({
      file: 'src/client/editor.tsx',
      metric: 'cc',
      cc: 15,
      value: 15,
      coverage: null,
      crap: null,
      band: 'moderate',
    });
    const { violations } = evaluateGate([watchCold, watchHot], {});
    expect(violations).toEqual([watchHot]);
    expect(GATE_STOPS).toEqual({ coreCrapStop: 30, watchlistCcStop: 15 });
  });
});

describe('toRiskEntry', () => {
  const fn = { name: 'fn', lineStart: 3, lineEnd: 9, cc: 5 };

  it('derives core rows: coverage join, CRAP metric, core stop', () => {
    const fileCov = {
      statementMap: {
        s0: { start: { line: 4 }, end: { line: 4 } },
        s1: { start: { line: 5 }, end: { line: 5 } },
      },
      s: { s0: 1, s1: 0 },
    };
    const e = toRiskEntry('src/core/matcher.ts', fn, fileCov);
    expect(e).toMatchObject({
      metric: 'crap',
      coverage: 0.5,
      crap: crapScore(5, 0.5),
      value: crapScore(5, 0.5),
      stop: 30,
      band: 'moderate',
    });
  });

  it('keeps the CRAP metric on the moved editing domain: packages/core rows stay covered-tier (#212)', () => {
    const fileCov = {
      statementMap: {
        s0: { start: { line: 4 }, end: { line: 4 } },
        s1: { start: { line: 5 }, end: { line: 5 } },
      },
      s: { s0: 1, s1: 0 },
    };
    const e = toRiskEntry('packages/core/src/matcher.ts', fn, fileCov);
    expect(e).toMatchObject({
      metric: 'crap',
      coverage: 0.5,
      crap: crapScore(5, 0.5),
      value: crapScore(5, 0.5),
      stop: 30,
    });
    // absent from the coverage JSON (never loaded by a test) reads as 0%,
    // keeping the CRAP term a discovery backstop: vacuous test discovery for
    // a moved module fails preflight, not silently passes
    const unloaded = toRiskEntry('packages/core/src/matcher.ts', fn, undefined);
    expect(unloaded).toMatchObject({ metric: 'crap', coverage: 0, value: crapScore(5, 0) });
  });

  it('keeps the CRAP metric on the registry seam and the boot-authority seams: covered-tier rows, later runtime seams watchlist (#221, #222)', () => {
    const fileCov = {
      statementMap: {
        s0: { start: { line: 4 }, end: { line: 4 } },
        s1: { start: { line: 5 }, end: { line: 5 } },
      },
      s: { s0: 1, s1: 0 },
    };
    const registryRow = toRiskEntry('packages/runtime/registry/document.ts', fn, fileCov);
    expect(registryRow).toMatchObject({
      metric: 'crap',
      coverage: 0.5,
      crap: crapScore(5, 0.5),
      value: crapScore(5, 0.5),
      stop: 30,
    });
    // the kernel-lease and private-boot seams joined the covered tier in
    // their own lane (#222): deterministic unit tests over real temp
    // SQLite lease files and a real in-memory private-IPC channel make
    // the per-function coverage claim real
    const leaseRow = toRiskEntry('packages/runtime/kernel-lease/kernel-lease.ts', fn, fileCov);
    expect(leaseRow).toMatchObject({
      metric: 'crap',
      coverage: 0.5,
      crap: crapScore(5, 0.5),
      value: crapScore(5, 0.5),
      stop: 30,
    });
    const bootRow = toRiskEntry('packages/runtime/private-boot/control-plane-boot.ts', fn, fileCov);
    expect(bootRow).toMatchObject({
      metric: 'crap',
      coverage: 0.5,
      crap: crapScore(5, 0.5),
      value: crapScore(5, 0.5),
      stop: 30,
    });
    // a runtime seam outside the ruled prefixes has no per-function
    // coverage claim yet — CC-only watchlist until its lane rules otherwise
    // (#237 ruled staging/ + clients/ + fence/; #238 ruled commit/ +
    // revocation/)
    const laterSeam = toRiskEntry('packages/runtime/session-supervisor/supervisor.ts', fn, fileCov);
    expect(laterSeam).toMatchObject({ metric: 'cc', coverage: null, crap: null, stop: 15 });
  });

  it('pins the covered-tier dispatch table: every covered prefix stays CRAP-metric, every watchlist exception stays CC-metric (#311)', () => {
    const fileCov = {
      statementMap: {
        s0: { start: { line: 4 }, end: { line: 4 } },
        s1: { start: { line: 5 }, end: { line: 5 } },
      },
      s: { s0: 1, s1: 0 },
    };
    // One representative per covered-prefix entry — the data-driven
    // rewrite (#311) is behavior-identical only if this enumeration holds:
    // a lane flipping its tier decision moves its row between these two
    // expectations and must do so here deliberately.
    const covered = [
      'src/core/crap.ts',
      'packages/core/src/matcher.ts',
      'packages/protocol/src/envelopes.ts',
      'packages/runtime/registry/document.ts',
      'packages/runtime/kernel-lease/kernel-lease.ts',
      'packages/runtime/private-boot/control-plane-boot.ts',
      'packages/runtime/edit-authority/grants/grant-table.ts',
      'packages/runtime/project-plane/worker/worker-events.ts',
      'packages/runtime/project-plane/supervision/close-report.ts',
      'packages/runtime/project-runtime/project-runtime.ts',
      'packages/runtime/origin/virtual-hosts.ts',
      'packages/runtime/origin/host-router.ts',
      'packages/runtime/proxy/upgrade-request.ts',
      'packages/runtime/astro-project-adapter/seam-readers.ts',
      // #234 (F2): one representative per new covered prefix — the
      // dispatch core (api/http) and the sanitized error responses
      // (api/errors).
      'packages/runtime/api/http/api-dispatch.ts',
      'packages/runtime/api/errors/error-responses.ts',
      // #235 (F3): one representative per new covered prefix — the
      // bounded pagination seams (api/pagination) and the SSE pure
      // seams (sse).
      'packages/runtime/api/pagination/page-contract.ts',
      'packages/runtime/sse/sse-admission.ts',
      // #236 (F4): one representative per new covered prefix — the
      // staged activation state machine (staging) and the
      // document-bound client registry (clients).
      'packages/runtime/session-supervisor/staging/session-supervisor.ts',
      'packages/runtime/session-supervisor/clients/session-clients.ts',
      // #237 (F5): one representative per new covered prefix — the
      // edit fence and bounded transition drain (fence).
      'packages/runtime/session-supervisor/fence/edit-fence.ts',
      // #238 (F6): one representative per new covered prefix — the
      // receipt-consuming commit coordinator (commit) and the ordered
      // authority revocation (revocation).
      'packages/runtime/session-supervisor/commit/switch-coordinator.ts',
      'packages/runtime/session-supervisor/revocation/authority-revocation.ts',
      // #239 (F7): one representative per new covered prefix — the
      // host-observed completion driver (completion) and the boot-scoped
      // tombstone machine (tombstone).
      'packages/runtime/session-supervisor/completion/replacement-completion.ts',
      'packages/runtime/session-supervisor/tombstone/boot-tombstone.ts',
    ];
    for (const file of covered) {
      expect(toRiskEntry(file, fn, fileCov).metric).toBe('crap');
    }
    // Every watchlist exception file — real IO composition under a
    // covered prefix: coverage handed to the row is ignored (metric
    // honesty), so the exception must hold even with fileCov present.
    const watchlist = [
      'packages/runtime/astro-project-adapter/composition.ts',
      'packages/runtime/astro-project-adapter/styles/join/client-scoped-css.ts',
      'packages/runtime/astro-project-adapter/styles/join/route-styles.ts',
      'packages/runtime/astro-project-adapter/styles/convergence/converged-styles-inspection.ts',
      'packages/runtime/project-plane/composition/composition-runtime.ts',
      'packages/runtime/project-plane/worker/worker-child.ts',
      'packages/runtime/project-plane/supervision/plane-supervisor.ts',
      'packages/runtime/project-plane/managed-astro/dev-server.ts',
      'packages/runtime/project-runtime/plane-launch.ts',
      // #233 (F1): the real socket IO under the new covered prefixes
      'packages/runtime/origin/origin-listener.ts',
      'packages/runtime/proxy/http-stream.ts',
      'packages/runtime/proxy/upgrade-tunnel.ts',
      'packages/runtime/proxy/proxy-health.ts',
      // #234 (F2): the API surface's reserved-handler socket composition
      'packages/runtime/api/http/reserved-handler.ts',
      // #235 (F3): the SSE surface's events-route socket composition
      'packages/runtime/sse/sse-surface.ts',
      // the evidence subtree exception, not just the exact files
      'packages/runtime/astro-project-adapter/certification/staging.ts',
    ];
    for (const file of watchlist) {
      expect(toRiskEntry(file, fn, fileCov)).toMatchObject({
        metric: 'cc',
        coverage: null,
        crap: null,
        stop: 15,
      });
    }
  });

  it('derives watchlist rows: no coverage term even when handed one, cc stop', () => {
    const e = toRiskEntry('src/node/rest.ts', fn, { statementMap: {}, s: {} });
    expect(e).toMatchObject({
      metric: 'cc',
      coverage: null,
      crap: null,
      value: 5,
      stop: 15,
      band: 'low',
      watchOnly: false,
    });
  });

  it('keeps the generated tier watch-only at its new home: packages/app-shell (#218)', () => {
    const e = toRiskEntry('packages/app-shell/src/components/ui/sidebar.tsx', fn, undefined);
    expect(e).toMatchObject({
      metric: 'cc',
      value: 5,
      stop: Number.POSITIVE_INFINITY,
      watchOnly: true,
    });
    expect(evaluateGate([e], {})).toEqual({ violations: [], grandfathered: [], improved: [] });
  });

  it('gates the rest of packages/app-shell on the watchlist CC stop (#218)', () => {
    // the generic editor infrastructure is hand-written, not regenerated:
    // coverage stays out (metric honesty) but the CC stop applies
    const e = toRiskEntry('packages/app-shell/src/editor/markdown-editor.tsx', fn, {
      statementMap: {},
      s: {},
    });
    expect(e).toMatchObject({ metric: 'cc', value: 5, stop: 15, watchOnly: false });
  });

  it('no longer grants watch-only at the legacy src/client ui/ path (retirement gate, #215)', () => {
    // the compatibility window closed with the integration: a file at the
    // dead prefix is an ordinary watchlist row, never the ungated tier —
    // re-adding the prefix must be a deliberate tier decision, not a leftover
    const e = toRiskEntry('src/client/components/ui/button.tsx', fn, undefined);
    expect(e).toMatchObject({
      metric: 'cc',
      value: 5,
      stop: 15,
      watchOnly: false,
    });
  });

  it('degrades to a CC-only row when the coverage run itself failed (null, not undefined)', () => {
    const e = toRiskEntry('src/core/matcher.ts', fn, null);
    expect(e).toMatchObject({ metric: 'cc', coverage: null, crap: null, value: 5, stop: 15 });
  });

  it('reads a core file absent from coverage as 0%, not degraded', () => {
    const e = toRiskEntry('src/core/matcher.ts', fn, undefined);
    expect(e.coverage).toBe(0);
    expect(e.crap).toBe(crapScore(5, 0));
    expect(e.metric).toBe('crap');
  });
});

describe('mergeBaseline', () => {
  const rest = 'src/node/rest.ts';

  it('tightens to the current value, drops recovered functions, refuses new violators', () => {
    const previous = {
      [baselineKey(rest, 'handleApiRequest', 38)]: 27,
      [baselineKey(rest, 'gone', 50)]: 40,
    };
    const handle = entry({
      file: rest,
      name: 'handleApiRequest',
      metric: 'cc',
      cc: 24,
      value: 24,
      coverage: null,
      crap: null,
      band: 'high',
    });
    const fresh = entry({
      file: rest,
      name: 'freshOffender',
      metric: 'cc',
      cc: 18,
      value: 18,
      coverage: null,
      crap: null,
      band: 'moderate',
    });

    const { next, refused } = mergeBaseline(previous, [handle, fresh]);
    expect(next).toEqual({ [baselineKey(rest, 'handleApiRequest', 38)]: 24 });
    expect(refused).toEqual([fresh]);
  });

  it('never raises an entry even when the function got worse', () => {
    const previous = { [baselineKey(rest, 'handleApiRequest', 38)]: 20 };
    const worse = entry({
      file: rest,
      name: 'handleApiRequest',
      metric: 'cc',
      cc: 27,
      value: 27,
      coverage: null,
      crap: null,
      band: 'high',
    });
    const { next } = mergeBaseline(previous, [worse]);
    expect(next[baselineKey(rest, 'handleApiRequest', 38)]).toBe(20);
  });
});
