import { describe, expect, it } from 'vitest';
import {
  inspectionKindSchema,
  inspectionRequestSchema,
  inspectionResultSchema,
} from './inspection';

/**
 * Inspection on the wire (ADR-0005: only typed `project`, `content`,
 * `routes`, `styles` requests; every result carries a monotonic resource
 * revision). The payload interior is contract-owned and opaque at this
 * layer; the closed kind discriminants are the protocol's surface.
 */
describe('inspectionRequestSchema', () => {
  it('accepts exactly the four closed kinds and nothing else', () => {
    for (const kind of ['project', 'content', 'routes', 'styles'] as const) {
      expect(inspectionRequestSchema.safeParse({ kind }).success, kind).toBe(true);
    }
    expect(inspectionRequestSchema.safeParse({ kind: 'modules' }).success).toBe(false);
    expect(inspectionRequestSchema.safeParse({ kind: 'fs-read' }).success).toBe(false);
  });

  it('rejects unknown fields — no client-selected filesystem path rides along', () => {
    expect(
      inspectionRequestSchema.safeParse({ kind: 'content', path: 'src/content' }).success,
    ).toBe(false);
    expect(inspectionRequestSchema.safeParse({ kind: 'routes', route: '/' }).success).toBe(false);
  });
});

describe('inspectionResultSchema', () => {
  it('carries a closed kind plus a nonnegative integer revision around the opaque payload', () => {
    const result = { kind: 'styles', revision: 7, payload: { records: [] } };
    expect(inspectionResultSchema.safeParse(result)).toEqual({ success: true, data: result });
    expect(
      inspectionResultSchema.safeParse({ kind: 'project', revision: 0, payload: null }).success,
    ).toBe(true);
  });

  it('rejects unknown kinds, malformed discriminants, and bad revisions', () => {
    expect(
      inspectionResultSchema.safeParse({ kind: 'vite', revision: 1, payload: null }).success,
    ).toBe(false);
    expect(inspectionResultSchema.safeParse({ revision: 1, payload: null }).success).toBe(false);
    expect(
      inspectionResultSchema.safeParse({ kind: 'content', revision: -1, payload: null }).success,
    ).toBe(false);
    expect(
      inspectionResultSchema.safeParse({ kind: 'content', revision: 1.5, payload: null }).success,
    ).toBe(false);
    expect(
      inspectionResultSchema.safeParse({ kind: 'content', revision: 1, payload: null, extra: 1 })
        .success,
    ).toBe(false);
  });

  it('enumerates the same closed family set as the kind enum', () => {
    expect(Object.values(inspectionKindSchema.enum)).toEqual([
      'project',
      'content',
      'routes',
      'styles',
    ]);
  });

  // #370, the ruling's additive wire shape: the styles request envelope
  // gains the observed-canvas-pathname selection — optionally, so the
  // pre-#370 shape still parses (closed unions stay closed; the field
  // rides the existing envelope, never a new kind — the #351 precedent).
  it('accepts the styles route selection additively — and still parses without one', () => {
    expect(inspectionRequestSchema.safeParse({ kind: 'styles' }).success).toBe(true);
    for (const route of ['/', '/blog/hello-builder', '/blog/2024/post', '/blog/']) {
      expect(inspectionRequestSchema.safeParse({ kind: 'styles', route }).success, route).toBe(
        true,
      );
    }
  });

  it('refuses route selections that are not observed pathnames', () => {
    // not pathnames at all, or shapes the canvas can never observe
    for (const route of [
      '', // empty
      'blog/hello-builder', // no leading slash — a relative shape
      './blog', // a relative-filesystem shape
      '/blog//x', // empty inner segment (protocol-relative-ish)
      '//evil.example/x', // protocol-relative — a URL, not a pathname
      '/blog?q=1', // a query — location.pathname never carries one
      '/blog#top', // a fragment
      '/blog\\x', // backslash
      '/blog hello', // whitespace
    ]) {
      expect(inspectionRequestSchema.safeParse({ kind: 'styles', route }).success, route).toBe(
        false,
      );
    }
    // A pathname-shaped selection that is no route (an absolute
    // filesystem path's shape among them) is NOT malformed — it parses,
    // and resolution answers the honest 404; the schema's job is the
    // pathname GRAMMAR alone (the value is client input, echoed nowhere).
    expect(
      inspectionRequestSchema.safeParse({ kind: 'styles', route: '/Users/woji/Dev' }).success,
    ).toBe(true);
    // non-string selections are equally malformed
    expect(inspectionRequestSchema.safeParse({ kind: 'styles', route: 42 }).success).toBe(false);
    // unknown siblings still refuse (the strict-object law)
    expect(
      inspectionRequestSchema.safeParse({ kind: 'styles', route: '/', extra: 1 }).success,
    ).toBe(false);
  });
});
