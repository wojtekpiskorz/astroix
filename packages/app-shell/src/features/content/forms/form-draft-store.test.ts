import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { sameDraftBinding, useFormDraftStore } from './form-draft-store.ts';

/**
 * The form-draft store's own laws (#252, J2 AC): the total reset law
 * (pair/collection/entry change resets the draft and its validation),
 * the values discipline (widget reports merge the unknown half back —
 * unknown fields never leave the draft, in any report order), and the
 * mode-switch law (raw materializes from the values; form remounts on
 * the current values; a parse failure never destroys values).
 */

const schemasFixture = inspectionFixture('content-schemas.json');

function frozenFields(collection: string): FormFieldNode[] {
  const schema = schemasFixture.schemas.find((entry) => entry.collection === collection);
  if (schema === undefined) throw new Error(`frozen corpus has no walk for ${collection}`);
  return schema.fields as FormFieldNode[];
}

const BLOG_FIELDS = frozenFields('blog');
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };
const OTHER_GENERATION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 5 };
const OTHER_EPOCH: SessionRef = { runtimeEpoch: 'epoch-two', generation: 4 };

const BLOG_BASELINE = {
  revision: 'a'.repeat(64),
  values: {
    title: 'Hello builder',
    date: '2026-08-26T00:00:00.000Z',
    tags: ['meta'],
    tone: 'bold',
    priority: 0,
    featured: false,
    custom: 'an unknown field',
  },
  body: 'First fixture post — flat id.',
};

const POST_BASELINE = {
  revision: 'b'.repeat(64),
  values: { title: 'Nested post', date: '2024-06-01T00:00:00.000Z', tags: ['nested'] },
  body: 'Fixture post.',
};

function store() {
  return useFormDraftStore.getState();
}

function openBlog(): void {
  store().open(
    SESSION,
    { ...SESSION, collection: 'blog', entryId: 'hello-builder' },
    BLOG_BASELINE,
    BLOG_FIELDS,
  );
}

afterEach(() => {
  store().clear();
});

describe('the total reset law', () => {
  it('opens the draft on the inspected baseline with the unknown half partitioned', () => {
    openBlog();
    const state = store();
    expect(state.binding).toEqual({
      runtimeEpoch: SESSION.runtimeEpoch,
      generation: SESSION.generation,
      collection: 'blog',
      entryId: 'hello-builder',
    });
    expect(state.draftValues).toEqual(BLOG_BASELINE.values);
    expect(state.unknownPart).toEqual({ custom: 'an unknown field' });
    expect(state.mode).toBe('form');
    expect(state.baseline?.revision).toBe(BLOG_BASELINE.revision);
  });

  it('resets the draft and its validation when the ENTRY changes (the edit dies with the selection)', () => {
    openBlog();
    store().reportFormValues({ ...BLOG_BASELINE.values, title: 'EDITED' });
    expect(store().draftValues).toMatchObject({ title: 'EDITED' });
    store().open(
      SESSION,
      { ...SESSION, collection: 'blog', entryId: '2024/post' },
      POST_BASELINE,
      BLOG_FIELDS,
    );
    const state = store();
    expect(state.draftValues).toEqual(POST_BASELINE.values);
    expect(state.parseError).toBeNull();
    expect(state.mode).toBe('form');
    expect(state.baseline?.values).toEqual(POST_BASELINE.values);
    // the mount identity moved: the form remounts on the fresh truth
    expect(state.mountId).toBeGreaterThan(1);
  });

  it('resets when the COLLECTION changes even at the same entry id', () => {
    openBlog();
    store().open(
      SESSION,
      { ...SESSION, collection: 'notes', entryId: 'hello-builder' },
      POST_BASELINE,
      frozenFields('notes'),
    );
    expect(store().draftValues).toEqual(POST_BASELINE.values);
  });

  it('resets when the GENERATION or the EPOCH changes (the ProjectKey carry: a new document is a new pair)', () => {
    openBlog();
    store().reportFormValues({ ...BLOG_BASELINE.values, title: 'EDITED' });
    for (const [index, ref] of [OTHER_GENERATION, OTHER_EPOCH].entries()) {
      store().open(
        ref,
        {
          runtimeEpoch: ref.runtimeEpoch,
          generation: ref.generation,
          collection: 'blog',
          entryId: 'hello-builder',
        },
        BLOG_BASELINE,
        BLOG_FIELDS,
      );
      expect(store().draftValues, `reset leg ${index}`).toEqual(BLOG_BASELINE.values);
    }
  });

  it('ignores an open whose actor does not speak for the binding pair (a stale render never opens)', () => {
    openBlog();
    store().open(
      OTHER_GENERATION,
      { ...SESSION, collection: 'blog', entryId: '2024/post' },
      POST_BASELINE,
      BLOG_FIELDS,
    );
    expect(store().binding?.entryId).toBe('hello-builder');
  });

  it('is a no-op on the SAME binding — a background refetch never clobbers a live draft', () => {
    openBlog();
    store().reportFormValues({ ...BLOG_BASELINE.values, title: 'EDITED' });
    store().open(
      SESSION,
      { ...SESSION, collection: 'blog', entryId: 'hello-builder' },
      { ...BLOG_BASELINE, revision: 'c'.repeat(64), values: { title: 'FROM REFETCH' } },
      BLOG_FIELDS,
    );
    expect(store().draftValues).toMatchObject({ title: 'EDITED' });
    // the baseline is the draft's own mount truth, never the refetch's
    expect(store().baseline?.revision).toBe(BLOG_BASELINE.revision);
  });

  it('sameDraftBinding compares by value across every field', () => {
    const binding = { ...SESSION, collection: 'blog', entryId: 'x' };
    expect(sameDraftBinding(binding, { ...binding })).toBe(true);
    expect(sameDraftBinding(binding, { ...binding, generation: binding.generation + 1 })).toBe(
      false,
    );
    expect(sameDraftBinding(binding, { ...binding, runtimeEpoch: 'other' })).toBe(false);
    expect(sameDraftBinding(binding, { ...binding, collection: 'notes' })).toBe(false);
    expect(sameDraftBinding(binding, { ...binding, entryId: 'y' })).toBe(false);
    expect(sameDraftBinding(null, null)).toBe(false);
  });
});

describe('the values discipline (the never-drop merge seam)', () => {
  it('merges the unknown half back into every form report — unknown fields never leave the draft', () => {
    openBlog();
    store().reportFormValues({ title: 'widget edit', tags: ['a'] });
    expect(store().draftValues).toEqual({
      title: 'widget edit',
      tags: ['a'],
      custom: 'an unknown field',
    });
  });

  it('re-derives the unknown half from the standing whole — a mount report after raw edits cannot clobber them', () => {
    openBlog();
    // raw-mode edit adds a second unknown key
    store().setMode('raw');
    store().reportRawText('title: raw edit\ncustom: keep\nextra: { nested: true }');
    expect(store().parseError).toBeNull();
    // back to form: the mount report arrives with the known half only
    store().setMode('form');
    store().reportFormValues({
      title: 'raw edit',
      date: '2026-08-26T00:00:00.000Z',
      tags: [],
      tone: 'bold',
      priority: 0,
      featured: false,
    });
    expect(store().draftValues).toEqual({
      title: 'raw edit',
      date: '2026-08-26T00:00:00.000Z',
      tags: [],
      tone: 'bold',
      priority: 0,
      featured: false,
      custom: 'keep',
      extra: { nested: true },
    });
  });

  it('lets the unknown-fields section edit its half wholesale — removals included', () => {
    openBlog();
    store().reportUnknownPart({ replaced: [1, 2] });
    const values = store().draftValues as Record<string, unknown>;
    // 'custom' is gone (the section dropped it), the known half stays
    expect(Object.hasOwn(values, 'custom')).toBe(false);
    expect(values.replaced).toEqual([1, 2]);
    expect(values.title).toBe('Hello builder');
  });

  it('keeps the last parsed values when the raw text breaks (the no-drop law)', () => {
    openBlog();
    store().setMode('raw');
    store().reportRawText('title: "unterminated');
    expect(store().parseError).not.toBeNull();
    expect(store().draftValues).toEqual(BLOG_BASELINE.values);
    // recovery restores the flow
    store().reportRawText('title: fixed\ncustom: kept');
    expect(store().parseError).toBeNull();
    expect(store().draftValues).toEqual({ title: 'fixed', custom: 'kept' });
  });
});

describe('the mode-switch law', () => {
  it('materializes the raw text from the current values on every raw entry', () => {
    openBlog();
    store().setMode('raw');
    expect(store().rawText).toContain('title: Hello builder');
    expect(store().rawText).toContain('custom: an unknown field');
    // edit in raw, detour through form, return: the text is the
    // CURRENT values' serialization, never a stale cache
    store().reportRawText('title: raw edit\ncustom: c');
    store().setMode('form');
    store().setMode('raw');
    expect(store().rawText).toContain('title: raw edit');
  });

  it('bumps the mount identity only on return from raw mode (the form remounts on current values)', () => {
    openBlog();
    const atOpen = store().mountId;
    store().setMode('raw');
    expect(store().mountId).toBe(atOpen);
    store().setMode('form');
    expect(store().mountId).toBe(atOpen + 1);
    // same-mode toggles and no-draft states are no-ops
    store().setMode('form');
    expect(store().mountId).toBe(atOpen + 1);
    store().clear();
    store().setMode('raw');
    expect(store().mode).toBe('form');
  });

  it('accepts raw-text reports only while the raw mode is live', () => {
    openBlog();
    store().reportRawText('title: should be ignored');
    expect(store().draftValues).toEqual(BLOG_BASELINE.values);
  });
});
