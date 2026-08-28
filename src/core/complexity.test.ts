import { describe, expect, it } from 'vitest';
import { analyzeComplexity, analyzeComplexityTsc } from './complexity';

/**
 * The counting-convention probe: every construct the rule counts (or
 * deliberately refuses to count), each pinned with its expected CC. The
 * expected values follow ESLint-classic semantics as measured during the
 * engine research (wayfinder #54); the two anonymous `(anonymous)` probes pin
 * naming, not counting. `engines agree` re-runs the same sources through the
 * tsc oracle so parser drift in either engine fails here, not in CI numbers.
 */

interface Probe {
  name: string;
  filename: string;
  source: string;
  expected: Array<[name: string, cc: number]>;
}

const PROBES: Probe[] = [
  {
    name: 'base',
    filename: 'probe.ts',
    source: 'export function plain(): number {\n  return 1;\n}\n',
    expected: [['plain', 1]],
  },
  {
    name: 'if / else-if',
    filename: 'probe.ts',
    source:
      'export function withIf(x: boolean): number {\n  if (x) return 1;\n  return 2;\n}\n' +
      'export function withElseIf(x: boolean): number {\n  if (x) return 1;\n  else if (!x) return 2;\n  return 3;\n}\n',
    expected: [
      ['withIf', 2],
      ['withElseIf', 3],
    ],
  },
  {
    name: 'loops',
    filename: 'probe.ts',
    source:
      'export function withFor(xs: number[]): number {\n  let n = 0;\n  for (let i = 0; i < xs.length; i += 1) n += 1;\n  return n;\n}\n' +
      'export function withForIn(o: Record<string, number>): number {\n  for (const k in o) o[k] = 1;\n  return 1;\n}\n' +
      'export function withForOf(xs: number[]): number {\n  for (const x of xs) if (x) return x;\n  return 0;\n}\n' +
      'export function withWhile(x: boolean): number {\n  while (x) return 1;\n  return 0;\n}\n' +
      'export function withDo(x: boolean): number {\n  do return 1; while (x)\n  return 0;\n}\n',
    expected: [
      ['withFor', 2],
      ['withForIn', 2],
      ['withForOf', 3],
      ['withWhile', 2],
      ['withDo', 2],
    ],
  },
  {
    name: 'switch: cases count, default does not',
    filename: 'probe.ts',
    source:
      'export function twoCasesDefault(x: number): number {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n      return 2;\n    default:\n      return 0;\n  }\n}\n' +
      'export function defaultOnly(x: number): number {\n  switch (x) {\n    default:\n      return 0;\n  }\n}\n',
    expected: [
      ['twoCasesDefault', 3],
      ['defaultOnly', 1],
    ],
  },
  {
    name: 'catch',
    filename: 'probe.ts',
    source:
      'export function withCatch(boom: () => void): number {\n  try {\n    boom();\n  } catch {\n    return 1;\n  }\n  return 0;\n}\n',
    expected: [['withCatch', 2]],
  },
  {
    name: 'ternary',
    filename: 'probe.ts',
    source: 'export function withTernary(x: boolean): number {\n  return x ? 1 : 2;\n}\n',
    expected: [['withTernary', 2]],
  },
  {
    name: 'short-circuit operators (incl. assignment forms)',
    filename: 'probe.ts',
    source:
      'export function logical3(a: boolean, b: boolean, c: boolean, d: boolean): boolean {\n  return (a && b) || (c ?? d);\n}\n' +
      'export function logicalAssign3(a?: number, b?: number, c?: number): void {\n  a ||= 1;\n  b &&= 2;\n  c ??= 3;\n}\n',
    expected: [
      ['logical3', 4],
      ['logicalAssign3', 4],
    ],
  },
  {
    name: 'labeled break is free',
    filename: 'probe.ts',
    source:
      'export function labeled(xs: number[]): number {\n  outer: for (const x of xs) {\n    if (x) continue outer;\n    return 0;\n  }\n  return 1;\n}\n',
    expected: [['labeled', 3]],
  },
  {
    name: 'optional chaining is free, ?? is not',
    filename: 'probe.ts',
    source:
      'export function chain(o: { p?: { q?: number } }): number {\n  return o?.p?.q ?? 0;\n}\n',
    expected: [['chain', 2]],
  },
  {
    name: 'default parameter values are not counted (pinned deviation from ESLint docs)',
    filename: 'probe.ts',
    source: 'export function withDefault(x: boolean, y: number = 2): number {\n  return y;\n}\n',
    expected: [['withDefault', 1]],
  },
  {
    name: 'decisions attribute to the innermost function',
    filename: 'probe.ts',
    source:
      'export function outer(x: boolean): () => number {\n  if (x) {\n    const inner = (): number => {\n      for (let i = 0; i < 1; i += 1) return i;\n      return 0;\n    };\n    return inner;\n  }\n  return () => 0;\n}\n',
    expected: [
      ['outer', 2],
      ['inner', 2],
      ['(anonymous)', 1],
    ],
  },
  {
    name: 'declaration-site naming',
    filename: 'probe.ts',
    source:
      'export class C {\n  method(x: boolean): number {\n    return x ? 1 : 0;\n  }\n  property = (x: boolean): number => (x ? 1 : 0);\n}\n' +
      'export const assigned = function (x: boolean): number {\n  return x ? 1 : 0;\n};\n' +
      'export const obj = {\n  key(x: boolean): number {\n    return x ? 1 : 0;\n  },\n' +
      "  'lit-key': function (x: boolean): number {\n    return x ? 1 : 0;\n  },\n};\n" +
      'export let assignedLater: (x: boolean) => number;\nassignedLater = function (x: boolean): number {\n  return x ? 1 : 0;\n};\n' +
      'export function host(cb: (x: boolean) => number): number {\n  return cb(true);\n}\nhost((x) => (x ? 1 : 0));\n',
    expected: [
      ['method', 2],
      ['property', 2],
      ['assigned', 2],
      ['key', 2],
      ['lit-key', 2],
      ['assignedLater', 2],
      ['host', 1],
      ['(anonymous)', 2],
    ],
  },
  {
    name: 'tsx: arrows in JSX attributes are functions',
    filename: 'probe.tsx',
    source:
      'export function Row({ onPick }: { onPick: (n: number) => void }): {\n  onClick: (n: number) => void;\n} {\n  const adjust = (n: number): void => {\n    if (n > 1) onPick(n);\n  };\n  return { onClick: adjust };\n}\n',
    expected: [
      ['Row', 1],
      ['adjust', 2],
    ],
  },
];

function byName(records: Array<{ name: string; cc: number }>): Array<[string, number]> {
  return records.map(({ name, cc }) => [name, cc]);
}

describe('analyzeComplexity (oxc engine)', () => {
  for (const probe of PROBES) {
    it(`counts ${probe.name}`, () => {
      expect(byName(analyzeComplexity(probe.source, probe.filename))).toEqual(probe.expected);
    });
  }

  it('records 1-based function line ranges', () => {
    const records = analyzeComplexity('export function first() {\n  return 1;\n}\n', 'probe.ts');
    expect(records[0]?.lineStart).toBe(1);
    expect(records[0]?.lineEnd).toBe(3);
  });
});

describe('analyzeComplexityTsc (oracle engine)', () => {
  for (const probe of PROBES) {
    it(`counts ${probe.name}`, () => {
      expect(byName(analyzeComplexityTsc(probe.source, probe.filename))).toEqual(probe.expected);
    });
  }
});

describe('engine agreement', () => {
  for (const probe of PROBES) {
    it(`oxc and tsc agree on ${probe.name}`, () => {
      expect(analyzeComplexity(probe.source, probe.filename)).toEqual(
        analyzeComplexityTsc(probe.source, probe.filename),
      );
    });
  }
});
