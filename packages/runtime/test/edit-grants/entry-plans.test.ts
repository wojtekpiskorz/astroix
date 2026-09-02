import type { ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import type { GrantedResource } from '../../edit-authority/grants/grant-table';
import { planEntryEdit } from '../../edit-authority/planning/entry-plans';

/**
 * Entry-domain planning (#223): the pure lift of an authorized content
 * wire plan — the entry vertical's serialized truth (core entry-writer
 * output) carried untouched and bound to the server-side grant record;
 * splice failing closed (that is the css splice-writer's primitive).
 */

const existing: GrantedResource = {
  canonicalRoot: '/canonical/root',
  session: { runtimeEpoch: 'epoch-a', generation: 3 },
  kind: 'content',
  operations: ['replace-contents', 'create-contents'],
  displayPath: 'src/content/hero/first.md',
  baseline: { type: 'sha256', sha256: 'b'.repeat(64) },
  target: { type: 'existing', canonicalPath: '/canonical/root/src/content/hero/first.md' },
};

const creation: GrantedResource = {
  canonicalRoot: '/canonical/root',
  session: { runtimeEpoch: 'epoch-a', generation: 3 },
  kind: 'content',
  operations: ['create-contents'],
  displayPath: 'src/content/hero/new.md',
  baseline: { type: 'expected-absent' },
  target: {
    type: 'creation',
    canonicalParent: '/canonical/root/src/content/hero',
    fileName: 'new.md',
  },
};

const SERIALIZED = '---\ntitle: First\n---\nbody\n';

function stubGrant(): ResourceGrant {
  return {
    token: 't'.repeat(43),
    kind: 'content',
    operations: ['replace-contents', 'create-contents'],
    displayPath: 'src/content/hero/first.md',
    baseline: { type: 'sha256', sha256: 'b'.repeat(64) },
  };
}

describe('planEntryEdit', () => {
  it('binds a replace-contents plan (the serialized raw truth) to the grant record', () => {
    const result = planEntryEdit(existing, {
      operation: 'replace-contents',
      grant: stubGrant(),
      contents: SERIALIZED,
    });
    expect(result).toEqual({
      ok: true,
      plan: { operation: 'replace-contents', resource: existing, contents: SERIALIZED },
    });
  });

  it('binds a create-contents plan to the expected-absent creation record', () => {
    const result = planEntryEdit(creation, {
      operation: 'create-contents',
      grant: {
        ...stubGrant(),
        operations: ['create-contents'],
        baseline: { type: 'expected-absent' },
      },
      contents: SERIALIZED,
    });
    expect(result).toEqual({
      ok: true,
      plan: { operation: 'create-contents', resource: creation, contents: SERIALIZED },
    });
  });

  it('fails closed on a splice wire plan (species guard)', () => {
    const result = planEntryEdit(existing, {
      operation: 'splice',
      grant: { ...stubGrant(), operations: ['replace-contents', 'splice'] },
      range: { start: 0, end: 3 },
      replacement: 'x',
    });
    expect(result).toEqual({
      ok: false,
      code: 'operation-not-allowed',
      message: expect.any(String),
    });
  });

  it('fails closed on create-contents against an existing-target grant (coherence guard)', () => {
    // Review round 1 on #304: the exact crossing the narrowed issuance
    // default prevents — a creation operation bound to an existing-target
    // revision contract must never become a plan, from any future minting
    // path or hand-built resource (D5's behavior on the shape is not
    // ours to assume).
    const result = planEntryEdit(existing, {
      operation: 'create-contents',
      grant: { ...stubGrant(), operations: ['create-contents'] },
      contents: SERIALIZED,
    });
    expect(result).toEqual({
      ok: false,
      code: 'operation-target-mismatch',
      message: expect.any(String),
    });
  });

  it('fails closed on replace-contents against a creation-target grant (coherence guard)', () => {
    const result = planEntryEdit(creation, {
      operation: 'replace-contents',
      grant: { ...stubGrant(), baseline: { type: 'expected-absent' } },
      contents: SERIALIZED,
    });
    expect(result).toEqual({
      ok: false,
      code: 'operation-target-mismatch',
      message: expect.any(String),
    });
  });
});
