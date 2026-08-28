import { describe, expect, it } from 'vitest';
import { buildSmokeReport, verifiedCount } from './smoke-report';
import { SMOKE_STEPS } from './smoke-steps';

const CONTEXT = {
  url: 'http://localhost:4312/',
  userAgent: 'vitest',
  isoTimestamp: '2026-08-28T21:07:00.000Z',
};

describe('verifiedCount', () => {
  it('counts only known step ids marked done', () => {
    expect(verifiedCount({})).toBe(0);
    expect(verifiedCount({ '1': true, '6b': true, unknown: true })).toBe(2);
  });
});

describe('buildSmokeReport', () => {
  it('renders the header, every step unchecked and the outstanding list', () => {
    const report = buildSmokeReport({}, {}, CONTEXT);
    expect(report).toContain('## Manual smoke report — 2026-08-28 21:07 UTC');
    expect(report).toContain('- URL: http://localhost:4312/');
    expect(report).toContain('- UA: vitest');
    expect(report).toContain('- Source: in-chrome smoke checklist');
    for (const step of SMOKE_STEPS) {
      expect(report).toContain(`- [ ] ${step.id} — ${step.title}`);
    }
    expect(report).toContain(
      `0/${SMOKE_STEPS.length} verified · outstanding: 1, 2, 3, 4, 5, 6, 6b, 7.`,
    );
    expect(report).toContain(
      '<!-- paste into a GitHub issue; an agent session picks it up from there -->',
    );
  });

  it('marks verified steps, inlines trimmed notes and clears the result when all pass', () => {
    const done = Object.fromEntries(SMOKE_STEPS.map((step) => [step.id, true]));
    const report = buildSmokeReport(done, { '3': '  outline visible  ' }, CONTEXT);
    expect(report).toContain('- [x] 3 — Select mode: hover + click the hero title');
    expect(report).toContain('  - note: outline visible');
    expect(report).not.toContain('- [ ]');
    expect(report).toContain(`${SMOKE_STEPS.length}/${SMOKE_STEPS.length} verified · all clear.`);
  });
});
