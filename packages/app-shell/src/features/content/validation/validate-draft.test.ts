import { describe, expect, it } from 'vitest';
import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { validateDraft } from './validate-draft.ts';

/**
 * The draft-validation tests (#252, J2 AC): the four diagnostic kinds —
 * field, schema, parse, stale-baseline — each pinned to its own source
 * of truth, over the FROZEN walked trees (the B1 content-schemas
 * corpus) so the report is judged against the contract-shaped schema
 * truth, never a re-declared one.
 */

const schemasFixture = inspectionFixture('content-schemas.json');

function frozenFields(collection: string): FormFieldNode[] {
  const schema = schemasFixture.schemas.find((entry) => entry.collection === collection);
  if (schema === undefined) throw new Error(`frozen corpus has no walk for ${collection}`);
  return schema.fields as FormFieldNode[];
}

/** The clean-input baseline — every leg below perturbs exactly one source. */
const CLEAN = {
  fields: frozenFields('blog'),
  values: {
    title: 'Hello builder',
    date: '2026-08-26T00:00:00.000Z',
    tags: ['meta'],
    tone: 'bold',
    priority: 0,
    featured: false,
  },
  parseError: null,
  baselineRevision: 'a'.repeat(64),
  liveRevision: 'a'.repeat(64),
} as const;

describe('the four diagnostic kinds', () => {
  it('reports a clean draft clean — no issues of any kind', () => {
    const report = validateDraft(CLEAN);
    expect(report.clean).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.inline).toEqual({});
  });

  it('FIELD: a value whose shape contradicts its walked kind is a field issue, inline on the path', () => {
    const report = validateDraft({
      ...CLEAN,
      values: { ...CLEAN.values, priority: 'not-a-number', featured: 'yes', tags: 'no-array' },
    });
    expect(report.clean).toBe(false);
    const kinds = new Map(report.issues.map((issue) => [issue.path, issue.kind]));
    expect(kinds.get('priority')).toBe('field');
    expect(kinds.get('featured')).toBe('field');
    expect(kinds.get('tags')).toBe('field');
    expect(report.inline.priority).toContain('number');
    expect(report.inline.tags).toContain('array');
  });

  it('FIELD: array rows with the wrong item shape are field issues on their row paths', () => {
    const report = validateDraft({
      ...CLEAN,
      values: { ...CLEAN.values, tags: ['ok', 42, true] },
    });
    expect(
      report.issues.filter((issue) => issue.kind === 'field').map((issue) => issue.path),
    ).toEqual(['tags.1', 'tags.2']);
  });

  it("SCHEMA: a missing required key is a schema issue (the walk's declared constraint)", () => {
    const values = { ...CLEAN.values } as Record<string, unknown>;
    delete values.title;
    const report = validateDraft({ ...CLEAN, values });
    const issue = report.issues.find((candidate) => candidate.path === 'title');
    expect(issue?.kind).toBe('schema');
    expect(issue?.message).toContain('required');
    // absent OPTIONAL keys are not issues: the frozen walk\'s optional
    // leaves (meta, aside) are legitimately absent here
    expect(report.issues.length).toBe(1);
  });

  it('SCHEMA: an enum value outside the declared options is a schema issue, in rows too', () => {
    const report = validateDraft({ ...CLEAN, values: { ...CLEAN.values, tone: 'sparkly' } });
    expect(report.issues.map((issue) => [issue.path, issue.kind])).toEqual([['tone', 'schema']]);
    expect(report.inline.tone).toContain('bold, calm');
    const enumItemFields: FormFieldNode[] = [
      {
        kind: 'array',
        path: 'flags',
        label: 'flags',
        required: false,
        item: { kind: 'enum', options: ['a', 'b'] },
      },
    ];
    const rows = validateDraft({ ...CLEAN, fields: enumItemFields, values: { flags: ['a', 'x'] } });
    expect(rows.issues.map((issue) => [issue.path, issue.kind])).toEqual([['flags.1', 'schema']]);
  });

  it('PARSE: the standing raw-text failure is one document-level parse issue', () => {
    const report = validateDraft({ ...CLEAN, parseError: 'unterminated string' });
    expect(report.clean).toBe(false);
    expect(report.issues.length).toBe(1);
    expect(report.issues[0]?.kind).toBe('parse');
    expect(report.issues[0]?.path).toBe('');
    // parse is document-level: it never lands in the inline map
    expect(report.inline).toEqual({});
  });

  it('STALE-BASELINE: a moved live revision is one document-level stale-baseline issue, field-clean or not', () => {
    const report = validateDraft({
      ...CLEAN,
      liveRevision: 'b'.repeat(64),
    });
    expect(report.issues.length).toBe(1);
    expect(report.issues[0]?.kind).toBe('stale-baseline');
    expect(report.issues[0]?.path).toBe('');
    expect(report.issues[0]?.message).toContain('changed on disk');
    // the file-less transition is a movement too: a revision that
    // existed and became null is stale, never silently fresh
    const lostFile = validateDraft({ ...CLEAN, liveRevision: null });
    expect(lostFile.issues[0]?.kind).toBe('stale-baseline');
  });

  it('keeps the kinds distinguishable when they co-occur: one report, four sources', () => {
    const values = { ...CLEAN.values, title: undefined, priority: 'x' };
    const report = validateDraft({
      ...CLEAN,
      values,
      parseError: 'broken',
      liveRevision: 'c'.repeat(64),
    });
    const kinds = [...new Set(report.issues.map((issue) => issue.kind))].sort();
    expect(kinds).toEqual(['field', 'parse', 'schema', 'stale-baseline']);
  });

  it('validates nested group children on their dotted paths (the frozen homepage cta group)', () => {
    const fields = frozenFields('homepage');
    const values = {
      title: 'Astroix fixture',
      lead: 'text',
      cta: { label: 42, href: 'https://astro.build' },
    };
    const report = validateDraft({ ...CLEAN, fields, values });
    expect(report.issues.map((issue) => [issue.path, issue.kind])).toEqual([
      ['cta.label', 'field'],
    ]);
    const missingLabel = validateDraft({
      ...CLEAN,
      fields,
      values: { title: 't', lead: 'l', cta: { href: 'https://astro.build' } },
    });
    expect(missingLabel.issues.map((issue) => [issue.path, issue.kind])).toEqual([
      ['cta.label', 'schema'],
    ]);
  });

  it('imposes no shape constraint on raw and image leaves (their documented non-law)', () => {
    const fields = frozenFields('gallery');
    // hero is the image kind: the projection\'s metadata object and any
    // raw-space shape round-trip untouched — display-only, no check
    const meta = validateDraft({
      ...CLEAN,
      fields,
      values: { hero: { src: '/x.png', width: 1, height: 1 }, alt: 'alt' },
    });
    expect(meta.clean).toBe(true);
    const rawFields = frozenFields('blog');
    // date and aside are raw kinds: any YAML-shaped value passes
    const raw = validateDraft({
      ...CLEAN,
      fields: rawFields,
      values: { ...CLEAN.values, date: { any: 'shape' }, aside: [1, 'two', null] },
    });
    expect(raw.clean).toBe(true);
  });
});
