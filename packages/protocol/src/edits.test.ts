import { describe, expect, it } from 'vitest';
import {
  editResultSchema,
  resourceGrantSchema,
  revisionContractSchema,
  sha256HexSchema,
  writePlanSchema,
} from './edits';
import { LIMITS } from './limits';

/**
 * Edit authority on the wire (ADR-0006 §6): opaque grants bound to a
 * revision contract, write plans over exactly three primitives, and the
 * 8 MiB per-editable-resource cap.
 */
const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const grant = {
  token: 'grant-opaque-token-1',
  kind: 'css',
  operations: ['splice'],
  displayPath: 'src/styles/global.css',
  baseline: { type: 'sha256', sha256: sha },
};

describe('resourceGrantSchema', () => {
  it('parses the opaque token plus its non-authoritative metadata', () => {
    expect(resourceGrantSchema.safeParse(grant)).toEqual({ success: true, data: grant });
    expect(
      resourceGrantSchema.safeParse({ ...grant, kind: 'content', operations: ['replace-contents'] })
        .success,
    ).toBe(true);
  });

  it('binds the revision contract: exact sha256 for existing, expected-absent for creation', () => {
    expect(revisionContractSchema.safeParse({ type: 'sha256', sha256: sha }).success).toBe(true);
    expect(revisionContractSchema.safeParse({ type: 'expected-absent' }).success).toBe(true);
    expect(revisionContractSchema.safeParse({ type: 'sha256', sha256: 'nope' }).success).toBe(
      false,
    );
    expect(revisionContractSchema.safeParse({ type: 'sha256' }).success).toBe(false);
    expect(sha256HexSchema.safeParse(sha.toUpperCase()).success).toBe(false);
  });

  it('keeps the display path project-relative — UI-only, never authority', () => {
    for (const displayPath of [
      '/abs/global.css',
      '..\\up.css',
      'a/../../b.css',
      'http://x/y.css',
    ]) {
      expect(resourceGrantSchema.safeParse({ ...grant, displayPath }).success, displayPath).toBe(
        false,
      );
    }
  });

  it('rejects empty token sets, unknown operation kinds, and unknown fields', () => {
    expect(resourceGrantSchema.safeParse({ ...grant, operations: [] }).success).toBe(false);
    expect(resourceGrantSchema.safeParse({ ...grant, operations: ['unlink'] }).success).toBe(false);
    expect(resourceGrantSchema.safeParse({ ...grant, fsPath: '/srv/project/x.css' }).success).toBe(
      false,
    );
  });
});

describe('writePlanSchema', () => {
  it('parses each of the three write primitives', () => {
    expect(
      writePlanSchema.safeParse({
        operation: 'replace-contents',
        grant,
        contents: 'body { margin: 0 }',
      }).success,
    ).toBe(true);
    expect(
      writePlanSchema.safeParse({
        operation: 'splice',
        grant,
        range: { start: 12, end: 30 },
        replacement: 'color: red',
      }).success,
    ).toBe(true);
    expect(
      writePlanSchema.safeParse({
        operation: 'create-contents',
        grant: { ...grant, operations: ['create-contents'], baseline: { type: 'expected-absent' } },
        contents: '---\ntitle: new\n---\n',
      }).success,
    ).toBe(true);
  });

  it('requires an ordered splice range', () => {
    expect(
      writePlanSchema.safeParse({
        operation: 'splice',
        grant,
        range: { start: 30, end: 12 },
        replacement: 'x',
      }).success,
    ).toBe(false);
    expect(
      writePlanSchema.safeParse({
        operation: 'splice',
        grant,
        range: { start: 12, end: 12 },
        replacement: 'x',
      }).success,
    ).toBe(false);
  });

  it('enforces the 8 MiB per-editable-resource cap over UTF-8 bytes (ADR-0006 §7)', () => {
    const atCap = 'x'.repeat(LIMITS.editableResourceBytes);
    const overCapByBytes = 'é'.repeat(LIMITS.editableResourceBytes / 2 + 1);
    expect(
      writePlanSchema.safeParse({ operation: 'replace-contents', grant, contents: atCap }).success,
    ).toBe(true);
    expect(
      writePlanSchema.safeParse({
        operation: 'replace-contents',
        grant,
        contents: `${atCap}x`,
      }).success,
    ).toBe(false);
    expect(
      writePlanSchema.safeParse({
        operation: 'replace-contents',
        grant,
        contents: overCapByBytes,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown operations and malformed plans', () => {
    expect(writePlanSchema.safeParse({ operation: 'delete', grant, contents: 'x' }).success).toBe(
      false,
    );
    expect(writePlanSchema.safeParse({ operation: 'splice', grant }).success).toBe(false);
    expect(
      writePlanSchema.safeParse({
        operation: 'replace-contents',
        grant,
        contents: 'x',
        expectedHash: sha, // the baseline lives in the grant's revision contract
      }).success,
    ).toBe(false);
  });
});

describe('editResultSchema', () => {
  it('returns the resulting revision and, where allowed, a follow-on grant bound to it', () => {
    expect(editResultSchema.safeParse({ revision: 8 }).success).toBe(true);
    expect(
      editResultSchema.safeParse({
        revision: 8,
        nextGrant: { ...grant, baseline: { type: 'sha256', sha256: sha } },
      }).success,
    ).toBe(true);
    expect(editResultSchema.safeParse({ revision: -1 }).success).toBe(false);
    expect(editResultSchema.safeParse({ revision: 1, nextGrant: { token: 't' } }).success).toBe(
      false,
    );
  });
});
