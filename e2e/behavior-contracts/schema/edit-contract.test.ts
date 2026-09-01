import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CssSpliceFixture, EditConflictFixture } from './edit-contract.ts';
import { EDIT_CONTRACT_VERSION, editFixtureSchemas } from './edit-contract.ts';

/**
 * The edit-contract validators under the unit doctrine (#217, directive
 * carried from B1's review): the schemas are pure zod, so their truth is
 * vitest-side — every frozen fixture parses, and the identity invariants
 * (untouched bytes, verbatim landing, hash revision state, disk retention,
 * confinement) reject what normalizes them away. The corpus files are read
 * from the sibling edit/ directory; no browser, no oracle.
 */

const EDIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'edit');

function frozen(name: string): unknown {
  return JSON.parse(readFileSync(join(EDIT_DIR, name), 'utf8')) as unknown;
}

describe('the frozen edit corpus validates against the versioned schema', () => {
  for (const name of Object.keys(editFixtureSchemas)) {
    it(`${name} parses and carries the contract version`, () => {
      const result = editFixtureSchemas[name as keyof typeof editFixtureSchemas].safeParse(
        frozen(name),
      );
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
      expect((frozen(name) as { contractVersion: string }).contractVersion).toBe(
        EDIT_CONTRACT_VERSION,
      );
    });
  }
});

describe('the edit schema rejects normalized-away write identity', () => {
  it('rejects a byte changed outside the splice window', () => {
    const data = frozen('css-splice.json') as CssSpliceFixture;
    // a byte appended after the window's end: the suffix region must end
    // the file byte-identically
    data.after.contents = `${data.after.contents} `;
    expect(editFixtureSchemas['css-splice.json'].safeParse(data).success).toBe(false);
  });

  it('rejects a success write whose expected hash does not name its baseline', () => {
    const data = frozen('css-splice.json') as CssSpliceFixture;
    data.edit.expectedHash = '0'.repeat(64);
    expect(editFixtureSchemas['css-splice.json'].safeParse(data).success).toBe(false);
  });

  it('rejects a landed write that differs from its posted bytes', () => {
    const data = frozen('content-frontmatter-write.json') as { after: { contents: string } };
    data.after.contents = `${data.after.contents} `;
    expect(editFixtureSchemas['content-frontmatter-write.json'].safeParse(data).success).toBe(
      false,
    );
  });

  it('rejects a conflict that retained anything but the raced disk bytes', () => {
    const data = frozen('css-conflict.json') as EditConflictFixture;
    data.retained.contents = data.baseline.contents;
    expect(editFixtureSchemas['css-conflict.json'].safeParse(data).success).toBe(false);
  });

  it('rejects a non-stale attempt (hash matching the raced disk)', () => {
    const data = frozen('css-conflict.json') as EditConflictFixture;
    data.attempt.expectedHash = data.interference.hash;
    expect(editFixtureSchemas['css-conflict.json'].safeParse(data).success).toBe(false);
  });

  it('rejects a negative battery that touched the disk', () => {
    const data = frozen('edit-negatives.json') as { disk: { after: { contents: string } } };
    data.disk.after.contents = `${data.disk.after.contents} `;
    expect(editFixtureSchemas['edit-negatives.json'].safeParse(data).success).toBe(false);
  });

  it('rejects absolute file paths in the corpus file fields', () => {
    const data = frozen('css-conflict.json') as EditConflictFixture;
    data.file = '/Users/oracle/home.css';
    expect(editFixtureSchemas['css-conflict.json'].safeParse(data).success).toBe(false);
  });
});
