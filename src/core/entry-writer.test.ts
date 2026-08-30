import { describe, expect, it } from 'vitest';
import { jsonEqual, parseEntryDraft, serializeEntry, splitEntryFile } from './entry-writer';

// A mechanical fixture, not the chrome's truth-space (that is the raw parse,
// parseEntryDraft below): the ISO date and the schema-default `tone` stay in
// the values deliberately — they exercise the serializer's JSON-twin node
// equality, which must hold for any draft an edit can produce.
const POST_RAW = `---\ntitle: Nested post\ndate: 2024-06-01\ntags: [nested]\n# author comment\nauthor: "Quoted Name"\n---\nFixture post with a nested-path id (\`2024/post\`) for route resolution.\n`;
const POST_BASELINE = {
  data: {
    title: 'Nested post',
    date: '2024-06-01T00:00:00.000Z',
    tags: ['nested'],
    tone: 'bold',
  },
  body: 'Fixture post with a nested-path id (`2024/post`) for route resolution.\n',
};

describe('splitEntryFile', () => {
  it('splits along the delimiters, keeping the block verbatim', () => {
    const split = splitEntryFile(POST_RAW);
    expect(split.frontmatter).toBe(
      '---\ntitle: Nested post\ndate: 2024-06-01\ntags: [nested]\n# author comment\nauthor: "Quoted Name"\n---',
    );
    expect(split.yaml).toBe(
      'title: Nested post\ndate: 2024-06-01\ntags: [nested]\n# author comment\nauthor: "Quoted Name"',
    );
    expect(split.close).toBe('\n');
    expect(split.body).toBe(
      'Fixture post with a nested-path id (`2024/post`) for route resolution.\n',
    );
  });

  it('reads an empty frontmatter block', () => {
    const split = splitEntryFile('---\n---\nbody\n');
    expect(split.frontmatter).toBe('---\n---');
    expect(split.yaml).toBe('');
    expect(split.body).toBe('body\n');
  });

  it('treats a closing --- at end-of-file as the block end', () => {
    const split = splitEntryFile('---\ntitle: x\n---');
    expect(split.frontmatter).toBe('---\ntitle: x\n---');
    expect(split.close).toBe('');
    expect(split.body).toBe('');
  });

  it('passes a file without frontmatter through as body', () => {
    const split = splitEntryFile('just a body\n');
    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe('just a body\n');
  });
});

describe('parseEntryDraft', () => {
  it('parses the raw truth: file scalars in JSON space, defaults absent, body trimmed', () => {
    const draft = parseEntryDraft(POST_RAW);
    expect(draft).toEqual({
      data: { title: 'Nested post', date: '2024-06-01', tags: ['nested'], author: 'Quoted Name' },
      body: 'Fixture post with a nested-path id (`2024/post`) for route resolution.',
    });
  });

  it('reads an empty frontmatter block as empty data', () => {
    expect(parseEntryDraft('---\n---\nbody\n')).toEqual({ data: {}, body: 'body' });
  });

  it('passes a file without frontmatter through as an empty-draft body', () => {
    expect(parseEntryDraft('just a body\n')).toEqual({ data: {}, body: 'just a body' });
  });

  it('round-trips dates through JSON — the space serializeEntry compares nodes in', () => {
    // a YAML timestamp the yaml package would resolve richly lands as its
    // JSON twin, so both diff sides of a mount write share one space
    const draft = parseEntryDraft('---\ndate: 2024-06-01T10:00:00Z\n---\nx\n');
    expect(draft?.data).toEqual({ date: '2024-06-01T10:00:00Z' });
  });

  it('returns null on a frontmatter the Document API cannot parse', () => {
    expect(parseEntryDraft('---\na: [\n---\n')).toBeNull();
  });
});

describe('serializeEntry', () => {
  it('returns the raw bytes unchanged when the draft equals the baseline', () => {
    const out = serializeEntry({
      raw: POST_RAW,
      baseline: POST_BASELINE,
      draft: { ...POST_BASELINE, body: POST_BASELINE.body },
    });
    expect(out).toBe(POST_RAW);
  });

  it('leaves bytes untouched when a stale baseline differs but the file already holds the draft', () => {
    // the payload raced a disk change (IDE edit, git restore): the baseline
    // carries the stale title, the draft the fresh one — and the file
    // already says the fresh one, so nothing may churn (no respace, no rewrite)
    const staleBaseline = {
      ...POST_BASELINE,
      data: { ...POST_BASELINE.data, title: 'Renamed post' },
    };
    const draft = { data: { ...POST_BASELINE.data }, body: POST_BASELINE.body };
    const out = serializeEntry({ raw: POST_RAW, baseline: staleBaseline, draft });
    expect(out).toBe(POST_RAW);
  });

  it('splices an edited scalar; untouched block lines stay byte-identical', () => {
    const draft = {
      data: { ...POST_BASELINE.data, title: 'Renamed post' },
      body: POST_BASELINE.body,
    };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toBe(
      POST_RAW.replace('title: Nested post', 'title: Renamed post').replace(
        'tags: [nested]',
        // the Document API's one normalization: flow spacing is canonical
        'tags: [ nested ]',
      ),
    );
  });

  it('keeps the raw date node untouched — the draft carries the ISO twin', () => {
    const draft = {
      data: { ...POST_BASELINE.data, title: 'Renamed post' },
      body: POST_BASELINE.body,
    };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('date: 2024-06-01\n');
  });

  it('never writes protected paths (image(): zod output rides the draft)', () => {
    const raw = `---\nhero: ../../assets/pixel.png\nalt: A single pixel\n---\nbody\n`;
    const baseline = {
      data: {
        hero: { src: '/pixel.png', width: 1, height: 1, ASTRO_ASSET: '/tmp/x' },
        alt: 'A single pixel',
      },
      body: 'body\n',
    };
    const draft = {
      data: {
        hero: { src: '/pixel.png', width: 1, height: 1, ASTRO_ASSET: '/tmp/y' },
        alt: 'A finer pixel',
      },
      body: 'body\n',
    };
    const out = serializeEntry({ raw, baseline, draft, protectedPaths: ['hero'] });
    expect(out).toBe(raw.replace('alt: A single pixel', 'alt: A finer pixel'));
  });

  it('preserves the comment and quoting of untouched keys while a sibling is edited', () => {
    const draft = {
      data: { ...POST_BASELINE.data, title: 'Renamed post' },
      body: POST_BASELINE.body,
    };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('# author comment\nauthor: "Quoted Name"\n');
  });

  it('replaces an edited array whole, keeping the flow style (respaced)', () => {
    const draft = { data: { ...POST_BASELINE.data, tags: ['a', 'b'] }, body: POST_BASELINE.body };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('tags: [ a, b ]\n');
  });

  it('writes an edited array in block style when the original was block', () => {
    const raw = `---\ntags:\n  - one\n---\n`;
    const baseline = { data: { tags: ['one'] }, body: '' };
    const draft = { data: { tags: ['one', 'two'] }, body: '' };
    expect(serializeEntry({ raw, baseline, draft })).toBe(`---\ntags:\n  - one\n  - two\n---\n`);
  });

  it('deletes payload-known keys the draft dropped, comments riding the key along', () => {
    // a comment attached to a key the payload carries (schema-known) — unlike
    // file-only keys, which zod strips from data and the diff never sees
    const raw = `---\ntitle: Nested post\n# tags comment\ntags: [nested]\nauthor: file-only\n---\nbody\n`;
    const baseline = { data: { title: 'Nested post', tags: ['nested'] }, body: 'body\n' };
    const draft = { data: { title: 'Nested post' }, body: 'body\n' };
    const out = serializeEntry({ raw, baseline, draft });
    expect(out).not.toContain('tags');
    expect(out).not.toContain('# tags comment');
    // file-only keys the schema never surfaced stay on disk untouched
    expect(out).toContain('author: file-only\n');
  });

  it('treats an undefined draft value as a deletion, never a null', () => {
    const draft = {
      data: { ...POST_BASELINE.data, author: undefined },
      body: POST_BASELINE.body,
    };
    const out = serializeEntry({
      raw: POST_RAW,
      baseline: { ...POST_BASELINE, data: { ...POST_BASELINE.data, author: 'Quoted Name' } },
      draft,
    });
    expect(out).not.toContain('author:');
    expect(out).not.toContain('author: null');
  });

  it('quotes scalars that would change type', () => {
    const draft = { data: { ...POST_BASELINE.data, title: '42' }, body: POST_BASELINE.body };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('title: "42"\n');
  });

  it('creates intermediate maps for nested keys missing from the file', () => {
    const draft = {
      data: { ...POST_BASELINE.data, meta: { source: 'manual' } },
      body: POST_BASELINE.body,
    };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('meta:\n  source: manual\n');
  });

  it('replaces a whole subtree when the draft changes its type', () => {
    const draft = {
      data: { ...POST_BASELINE.data, title: { en: 'Nested', pl: 'Zagnieżdżony' } },
      body: POST_BASELINE.body,
    };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('title:\n  en: Nested\n  pl: Zagnieżdżony\n');
  });

  it('writes a body-only edit with the frontmatter slice byte-identical', () => {
    const draft = { data: POST_BASELINE.data, body: `${POST_BASELINE.body}Typed more.\n` };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(
      out.startsWith(
        '---\ntitle: Nested post\ndate: 2024-06-01\ntags: [nested]\n# author comment\nauthor: "Quoted Name"\n---\n',
      ),
    ).toBe(true);
    expect(out.endsWith('Typed more.\n')).toBe(true);
  });

  it("re-anchors a trimmed payload body in the file's own whitespace", () => {
    // astro serves the body trimmed; the file keeps its blank line and final
    // newline — an edited body must land between them, byte-surgically
    const raw = '---\ntitle: x\n---\n\nBody line.\n';
    const baseline = { data: { title: 'x' }, body: 'Body line.' };
    const draft = { data: { title: 'x' }, body: 'Body line. Typed.' };
    expect(serializeEntry({ raw, baseline, draft })).toBe(
      '---\ntitle: x\n---\n\nBody line. Typed.\n',
    );
  });

  it('edits both halves in one write', () => {
    const draft = { data: { ...POST_BASELINE.data, title: 'Renamed' }, body: 'New body.\n' };
    const out = serializeEntry({ raw: POST_RAW, baseline: POST_BASELINE, draft });
    expect(out).toContain('title: Renamed\n');
    expect(out).toContain('date: 2024-06-01\n');
    expect(out.endsWith('---\nNew body.\n')).toBe(true);
  });

  it('replaces the whole root when the draft is not an object (root raw scalar)', () => {
    const raw = `---\nkind: scratchpad\npinned: true\n---\nnote body\n`;
    const baseline = { data: { kind: 'scratchpad', pinned: true }, body: 'note body\n' };
    const out = serializeEntry({
      raw,
      baseline,
      draft: { data: 'just a string', body: 'note body\n' },
    });
    expect(out.startsWith('---\njust a string\n---\n')).toBe(true);
  });

  it('creates a frontmatter block for a file without one', () => {
    const raw = 'body only\n';
    const baseline = { data: {}, body: 'body only\n' };
    const out = serializeEntry({
      raw,
      baseline,
      draft: { data: { title: 'New' }, body: 'body only\n' },
    });
    expect(out).toBe(`---\ntitle: New\n---\nbody only\n`);
  });

  it('throws on a hand-broken frontmatter instead of writing blind', () => {
    const raw = '---\nkey: [unclosed\n---\nbody\n';
    expect(() =>
      serializeEntry({
        raw,
        baseline: { data: {}, body: 'body\n' },
        draft: { data: { title: 'x' }, body: 'body\n' },
      }),
    ).toThrow();
  });
});

describe('jsonEqual', () => {
  it('compares deep over JSON space, key order irrelevant', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual(null, undefined)).toBe(false);
  });
});
