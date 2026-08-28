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

  it('marks generated ui/ rows watch-only: visible, never gated', () => {
    const e = toRiskEntry('src/client/components/ui/button.tsx', fn, undefined);
    expect(e).toMatchObject({
      metric: 'cc',
      value: 5,
      stop: Number.POSITIVE_INFINITY,
      watchOnly: true,
    });
    expect(evaluateGate([e], {})).toEqual({ violations: [], grandfathered: [], improved: [] });
    expect(mergeBaseline({}, [e]).next).toEqual({});
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
