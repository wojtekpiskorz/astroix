import { describe, expect, it } from 'vitest';
import { validateDraft } from '../validation/validate-draft.ts';
import { intentStateOf, plainEquals, toEditIntent } from './edit-intent.ts';

/**
 * The edit-intent property tests (#252, J2 AC): form-to-intent
 * conversion NEVER drops untouched source values — the draft store's
 * merge seam and the intent's materialization composed, over seeded
 * generated baselines with random touch sets. Also the state
 * vocabulary (none/ready/invalid) and the revision/baseline carry.
 */

// --- the seeded generator (the lane's shared idiom: deterministic, no property library) ---

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

/** Generates a JSON-plain baseline record with string keys. */
function generateBaseline(random: () => number): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const keys = 3 + Math.floor(random() * 5);
  for (let index = 0; index < keys; index += 1) {
    const leaf = Math.floor(random() * 4);
    if (leaf === 0) record[`k${index}`] = `value ${Math.floor(random() * 1000)}`;
    else if (leaf === 1) record[`k${index}`] = Math.floor(random() * 1000);
    else if (leaf === 2) record[`k${index}`] = random() < 0.5;
    else record[`k${index}`] = { nested: [Math.floor(random() * 10), `s${index}`] };
  }
  return record;
}

/** Picks a random subset of the keys — the "touched" set. */
function pickTouched(random: () => number, keys: readonly string[]): Set<string> {
  const touched = new Set<string>();
  for (const key of keys) {
    if (random() < 0.4) touched.add(key);
  }
  return touched;
}

/** One simulated widget edit on a touched key: a new value of a JSON-plain shape. */
function widgetEdit(random: () => number, current: unknown): unknown {
  const roll = Math.floor(random() * 3);
  if (roll === 0) return `edited ${Math.floor(random() * 1000)}`;
  if (roll === 1) return Math.floor(random() * 1000);
  if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    return { ...(current as Record<string, unknown>), added: true };
  }
  return [1, 2, 3];
}

/** The draft pipeline under property: widget reports (the known half) merged through the store's seam. */
function draftAfterEdits(
  baselineValues: Record<string, unknown>,
  knownKeys: readonly string[],
  touched: ReadonlySet<string>,
  random: () => number,
): Record<string, unknown> {
  // the partition: known half = the touched editing space, unknown half = the rest
  const known: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(baselineValues)) {
    (knownKeys.includes(key) ? known : unknown)[key] = value;
  }
  // the widget edits inside the known half (a touched key may also be
  // DELETED — the widget-space's honest edit vocabulary)
  const reported: Record<string, unknown> = { ...known };
  for (const key of touched) {
    if (!(key in reported)) continue;
    if (random() < 0.15) {
      delete reported[key];
    } else {
      reported[key] = widgetEdit(random, reported[key]);
    }
  }
  // the store's merge seam: the unknown half re-derived from the
  // standing whole and merged back
  const merged = { ...reported };
  for (const [key, value] of Object.entries(unknown)) {
    if (
      typeof merged[key] === 'object' &&
      merged[key] !== null &&
      !Array.isArray(merged[key]) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = { ...(merged[key] as object), ...(value as object) };
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

const FIELDS = [
  { kind: 'string', path: 'title', label: 'title', required: true },
  { kind: 'number', path: 'priority', label: 'priority', required: false },
] as const;

function validationOver(values: unknown) {
  return validateDraft({
    fields: FIELDS,
    values,
    parseError: null,
    baselineRevision: 'a'.repeat(64),
    liveRevision: 'a'.repeat(64),
  });
}

describe('the never-drop property (form-to-intent conversion)', () => {
  it('an intent built from widget reports retains EVERY untouched baseline value, deep, over 300 seeded iterations', () => {
    const random = rng(252);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const baselineValues = generateBaseline(random);
      const keys = Object.keys(baselineValues);
      const knownKeys = keys.filter((_, index) => index % 2 === 0);
      const touched = pickTouched(random, knownKeys);
      const values = draftAfterEdits(baselineValues, knownKeys, touched, random);
      const validation = validationOver(values);
      const derivation = {
        binding: { runtimeEpoch: 'e', generation: 1, collection: 'blog', entryId: 'x' },
        baseline: { revision: 'a'.repeat(64), values: baselineValues, body: 'body' },
        values,
        validation,
      };
      const intent = toEditIntent(derivation);
      // an untouched-titled draft still yields an intent when any other
      // key moved; the property under test is retention either way
      if (intent === null) continue;
      for (const [key, baselineValue] of Object.entries(baselineValues)) {
        if (touched.has(key)) continue;
        expect(intent.values, `iteration ${iteration}, key ${key}`).toMatchObject({
          [key]: baselineValue,
        });
      }
      // the revision and the source baseline ride the intent verbatim
      expect(intent.revision).toBe('a'.repeat(64));
      expect(intent.baseline.values).toEqual(baselineValues);
      expect(intent.baseline.body).toBe('body');
    }
  });

  it('the raw-mode circuit drops nothing either: values edited as YAML re-enter the same law', () => {
    const random = rng(2026);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const baselineValues = generateBaseline(random);
      const keys = Object.keys(baselineValues);
      const touched = pickTouched(random, keys);
      // raw mode edits the WHOLE values — untouched keys are copied as-is
      const values: Record<string, unknown> = { ...baselineValues };
      for (const key of touched) {
        values[key] = widgetEdit(random, values[key]);
      }
      const derivation = {
        binding: { runtimeEpoch: 'e', generation: 1, collection: 'blog', entryId: 'x' },
        baseline: { revision: 'b'.repeat(64), values: baselineValues, body: null },
        values,
        validation: validationOver(values),
      };
      const intent = toEditIntent(derivation);
      if (intent === null) continue;
      expect(intent.values).toEqual(values);
      for (const [key, baselineValue] of Object.entries(baselineValues)) {
        if (touched.has(key)) continue;
        expect(
          (intent.values as Record<string, unknown>)[key],
          `iteration ${iteration}: ${key}`,
        ).toEqual(baselineValue);
      }
    }
  });
});

describe('the intent state vocabulary', () => {
  const binding = { runtimeEpoch: 'e', generation: 1, collection: 'blog', entryId: 'x' };

  it('none: a clean draft that still equals its baseline has nothing to write', () => {
    const values = { title: 'same', priority: 1 };
    const derivation = {
      binding,
      baseline: { revision: 'a'.repeat(64), values, body: null },
      values,
      validation: validationOver(values),
    };
    expect(intentStateOf(derivation)).toBe('none');
    expect(toEditIntent(derivation)).toBeNull();
  });

  it('ready: a clean edited draft materializes the intent with the revision and source baseline', () => {
    const baselineValues = { title: 'old', priority: 1 };
    const values = { title: 'new', priority: 1 };
    const intent = toEditIntent({
      binding,
      baseline: { revision: 'c'.repeat(64), values: baselineValues, body: 'carried' },
      values,
      validation: validationOver(values),
    });
    expect(intent).toEqual({
      collection: 'blog',
      entryId: 'x',
      revision: 'c'.repeat(64),
      baseline: { values: baselineValues, body: 'carried' },
      values,
    });
  });

  it('invalid: any diagnostic blocks the intent — each kind alone', () => {
    const baseline = { revision: 'a'.repeat(64), values: { title: 'x', priority: 1 }, body: null };
    const edited = { title: 'y', priority: 1 };
    const legs = [
      // field
      validateDraft({
        fields: FIELDS,
        values: { title: 'y', priority: 'x' },
        parseError: null,
        baselineRevision: 'a'.repeat(64),
        liveRevision: 'a'.repeat(64),
      }),
      // parse
      validateDraft({
        fields: FIELDS,
        values: edited,
        parseError: 'broken',
        baselineRevision: 'a'.repeat(64),
        liveRevision: 'a'.repeat(64),
      }),
      // stale-baseline
      validateDraft({
        fields: FIELDS,
        values: edited,
        parseError: null,
        baselineRevision: 'a'.repeat(64),
        liveRevision: 'b'.repeat(64),
      }),
    ];
    for (const [index, validation] of legs.entries()) {
      const derivation = { binding, baseline, values: edited, validation };
      expect(intentStateOf(derivation), `leg ${index}`).toBe('invalid');
      expect(toEditIntent(derivation), `leg ${index}`).toBeNull();
    }
  });

  it('invalid: a standing parse failure blocks even an untouched-values draft (the raw surface is ahead)', () => {
    const values = { title: 'x', priority: 1 };
    const validation = validateDraft({
      fields: FIELDS,
      values,
      parseError: 'mid-edit breakage',
      baselineRevision: 'a'.repeat(64),
      liveRevision: 'a'.repeat(64),
    });
    const derivation = {
      binding,
      baseline: { revision: 'a'.repeat(64), values, body: null },
      values,
      validation,
    };
    expect(intentStateOf(derivation)).toBe('invalid');
    expect(toEditIntent(derivation)).toBeNull();
  });
});

describe('plainEquals (the edited-detector)', () => {
  it('compares records order-insensitively, arrays positionally, and primitives by identity', () => {
    expect(plainEquals({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(plainEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(plainEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(plainEquals([1, 2], [2, 1])).toBe(false);
    expect(plainEquals('x', 'x')).toBe(true);
    expect(plainEquals(null, null)).toBe(true);
    expect(plainEquals(undefined, null)).toBe(false);
  });
});
