import { describe, expect, it } from 'vitest';
import { parseRawText, toRawText } from './raw-text.ts';

/**
 * The raw representation's text space (#252, J2): the roundtrip law
 * over JSON-plain trees (the E4 payload's space) — the AC's
 * form↔raw-switching preservation property's pure core — plus the
 * parse-failure and cleared-text laws.
 */

// --- the seeded generator (same idiom as the partition tests) ---

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateTree(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth <= 0 || roll < 0.4) {
    const leaf = Math.floor(random() * 5);
    if (leaf === 0) return `text ${Math.floor(random() * 1000)}`;
    if (leaf === 1) return Math.floor(random() * 1000);
    if (leaf === 2) return random() < 0.5;
    if (leaf === 3) return null;
    return '2024-06-01T00:00:00.000Z'; // the ISO-date spelling the wire carries
  }
  if (roll < 0.6) {
    return Array.from({ length: Math.floor(random() * 3) }, () => generateTree(random, depth - 1));
  }
  const record: Record<string, unknown> = {};
  const keys = Math.floor(random() * 4) + 1;
  for (let index = 0; index < keys; index += 1) {
    record[`key${index}`] = generateTree(random, depth - 1);
  }
  return record;
}

describe('toRawText / parseRawText', () => {
  it('round-trips the fixture entry values — the values survive a form→raw→form circuit', () => {
    const values = {
      title: 'Nested post',
      date: '2024-06-01T00:00:00.000Z',
      tags: ['nested'],
      tone: 'bold',
      priority: 0,
      featured: false,
      meta: { source: 'https://example.com' },
    };
    const text = toRawText(values);
    const parsed = parseRawText(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.values).toEqual(values);
  });

  it('round-trips every seeded generated JSON-plain tree (400 iterations)', () => {
    const random = rng(252);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const values = generateTree(random, 4);
      // the documented law's boundary: a TOP-LEVEL null root serializes
      // as the empty draft (absent roots start empty, not as `null`) —
      // the roundtrip law covers the value trees the pane actually holds
      if (values === null) continue;
      const parsed = parseRawText(toRawText(values));
      expect(parsed.ok, `iteration ${iteration}`).toBe(true);
      if (parsed.ok) expect(parsed.values, `iteration ${iteration}`).toEqual(values);
    }
  });

  it('reports broken YAML as a parse failure with a message, never values', () => {
    const parsed = parseRawText('title: "unterminated');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message.length).toBeGreaterThan(0);
  });

  it('treats cleared text as the empty draft, not null', () => {
    expect(parseRawText('')).toEqual({ ok: true, values: {} });
    expect(parseRawText('   ')).toEqual({ ok: true, values: {} });
  });

  it('serializes absent and null roots as empty text', () => {
    expect(toRawText(undefined)).toBe('');
    expect(toRawText(null)).toBe('');
  });
});
