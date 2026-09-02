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
});
