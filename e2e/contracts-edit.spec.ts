import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type {
  ContentValidateFixture,
  ContentWriteFixture,
  CssSpliceFixture,
  EditConflictFixture,
  EditNegativesFixture,
} from './behavior-contracts/schema/edit-contract.ts';
import {
  EDIT_CONTRACT_VERSION,
  editFixtureSchemas,
} from './behavior-contracts/schema/edit-contract.ts';
import { captureEditCorpus, EDIT_CORPUS_MANIFEST } from './contract-oracle/edit-capture.ts';
import {
  assertNoForbiddenArtifacts,
  serializeFixture,
  skipWithoutChromium,
} from './contract-oracle/live-capture.ts';
import { MAIN_PORT, withOracleServer } from './contract-oracle/oracle-server.ts';

/**
 * The edit behavior-contract suite (#217, lane B2): the frozen corpus under
 * e2e/behavior-contracts/edit/ is (a) validated against the versioned
 * schema, (b) hygiene-scanned for the artifacts AC-5 forbids, and (c)
 * re-derived from a fresh disposable-oracle run through the exact capture
 * pipeline that froze it — byte-for-byte. That last leg is the freeze: the
 * retired integration's write authority (running only as the disposable
 * oracle) is the evidence producer, and the negative cases prove the
 * comparison cannot pass a corpus that normalized output bytes, hash
 * revision state, untouched regions, or the disk retention a rejected
 * write owes.
 *
 * Server boots go through e2e/contract-oracle/oracle-server.ts — the
 * no-E2E interval's playwright.config.ts carries no webServers
 * (ADR-0010, amended 2026-09-01), so the suite owns its evidence
 * producers' lifecycle.
 */

const FIXTURE_DIR = join('e2e', 'behavior-contracts', 'edit');

function frozenText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function frozenJson<T>(name: string): T {
  return JSON.parse(frozenText(name)) as T;
}

function expectSchemaRejects(
  name: keyof typeof editFixtureSchemas,
  mutate: (data: unknown) => void,
  because: string,
): void {
  const data = JSON.parse(frozenText(name));
  mutate(data);
  const result = editFixtureSchemas[name].safeParse(data);
  expect(result.success, `${name}: ${because}`).toBe(false);
}

test('every frozen edit fixture validates against the versioned schema and carries no forbidden artifacts', () => {
  // The manifest is the single enumeration of the frozen set — it must
  // agree with the schema registry exactly, so a fixture cannot be frozen
  // without also being re-frozen (and a schema without a manifest entry,
  // which would silently never re-derive, fails here too).
  expect(EDIT_CORPUS_MANIFEST.map((entry) => entry.file).sort()).toEqual(
    Object.keys(editFixtureSchemas).sort(),
  );
  for (const [name, schema] of Object.entries(editFixtureSchemas)) {
    const text = frozenText(name);
    const data = JSON.parse(text);
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(`${name} fails its schema: ${JSON.stringify(result.error.issues)}`);
    }
    expect(data.contractVersion, `${name} carries the schema's contractVersion`).toBe(
      EDIT_CONTRACT_VERSION,
    );
    assertNoForbiddenArtifacts(text, name);
  }
});

test('the schema rejects fixtures that normalize write identity away (negative cases)', () => {
  // output bytes: a byte changed inside the untouched window must be rejected
  expectSchemaRejects(
    'css-splice.json',
    (data) => {
      const fixture = data as CssSpliceFixture;
      // a byte appended after the window's end: the suffix region must end
      // the file byte-identically
      fixture.after.contents = `${fixture.after.contents} `;
    },
    'a byte changed outside the splice window must be rejected',
  );
  // posted bytes ≠ disk bytes: the whole-file write must land verbatim
  expectSchemaRejects(
    'content-frontmatter-write.json',
    (data) => {
      const fixture = data as ContentWriteFixture;
      fixture.after.contents = `${fixture.after.contents}\n`;
    },
    'a write that landed anything but its posted bytes verbatim must be rejected',
  );
  // hash revision state: the optimistic guard's precondition
  expectSchemaRejects(
    'css-splice.json',
    (data) => {
      (data as CssSpliceFixture).edit.expectedHash = '0'.repeat(64);
    },
    'a success write whose expected hash does not name its baseline must be rejected',
  );
  // conflict semantics: a 409 that retained anything but the raced disk
  expectSchemaRejects(
    'css-conflict.json',
    (data) => {
      const fixture = data as EditConflictFixture;
      fixture.retained.contents = fixture.baseline.contents;
    },
    'a rejected write that did not retain the raced disk bytes must be rejected',
  );
  expectSchemaRejects(
    'css-conflict.json',
    (data) => {
      const fixture = data as EditConflictFixture;
      fixture.attempt.expectedHash = fixture.interference.hash;
    },
    'an attempt whose hash matches the raced disk is not stale — rejected',
  );
  // the advisory loop's signal: an invalid probe with no issues normalizes the advisory away
  expectSchemaRejects(
    'content-validate.json',
    (data) => {
      const fixture = data as ContentValidateFixture;
      fixture.invalid.response = { ok: true, issues: [] };
    },
    'an invalid probe without issues must be rejected',
  );
  // negatives' disk-untouched proof
  expectSchemaRejects(
    'edit-negatives.json',
    (data) => {
      const fixture = data as EditNegativesFixture;
      fixture.disk.after.contents = `${fixture.disk.after.contents} `;
    },
    'a negative battery that touched the disk must be rejected',
  );
  // confinement shape: file fields are project-relative (the negative REQUEST
  // inputs may carry traversal paths; the corpus's own file fields may not)
  expectSchemaRejects(
    'css-conflict.json',
    (data) => {
      (data as EditConflictFixture).file = '/abs/path/home.css';
    },
    'an absolute file path must be rejected',
  );
});

test('the freeze comparison is byte- and order-sensitive (mutation negatives)', () => {
  const cssText = frozenText('css-splice.json');
  const css = frozenJson<CssSpliceFixture>('css-splice.json');

  const flippedByte = structuredClone(css);
  flippedByte.after.contents = flippedByte.after.contents.replace('3.5rem', '3.6rem');
  expect(serializeFixture(flippedByte), 'output bytes are preserved exactly').not.toBe(cssText);

  const shiftedRange = structuredClone(css);
  shiftedRange.edit.range = {
    ...shiftedRange.edit.range,
    start: shiftedRange.edit.range.start + 1,
  };
  expect(serializeFixture(shiftedRange), 'splice ranges are preserved exactly').not.toBe(cssText);

  const rehashed = structuredClone(css);
  rehashed.edit.expectedHash = '0'.repeat(64);
  expect(serializeFixture(rehashed), 'expected-hash revision state is preserved exactly').not.toBe(
    cssText,
  );

  const conflictText = frozenText('css-conflict.json');
  const conflict = frozenJson<EditConflictFixture>('css-conflict.json');
  const swappedTruth = structuredClone(conflict);
  swappedTruth.response.body.contents = swappedTruth.baseline.contents;
  expect(
    serializeFixture(swappedTruth),
    'the 409 disk-truth handback is preserved exactly',
  ).not.toBe(conflictText);

  const validateText = frozenText('content-validate.json');
  const validate = frozenJson<ContentValidateFixture>('content-validate.json');
  const droppedIssue = structuredClone(validate);
  droppedIssue.invalid.response.issues = droppedIssue.invalid.response.issues.slice(1);
  expect(serializeFixture(droppedIssue), 'advisory issue records are preserved').not.toBe(
    validateText,
  );
});

// the negative-mutation battery here has a vitest twin over the validators
// (e2e/behavior-contracts/schema/edit-contract.test.ts) — new invariants go
// in BOTH: the spec owns corpus truth, vitest owns validator truth
test('freeze: the main oracle still produces the frozen edit corpus byte-for-byte', {
  tag: '@oracle-boot',
}, async () => {
  skipWithoutChromium();
  test.setTimeout(240_000);
  const corpus = await captureEditCorpus(MAIN_PORT);
  // an emptied manifest would freeze nothing, greenly
  expect(EDIT_CORPUS_MANIFEST.length, 'the edit manifest must be non-empty').toBeGreaterThan(0);
  for (const { file, leg } of EDIT_CORPUS_MANIFEST) {
    expect(serializeFixture(corpus[leg]), `${file} drifted from the frozen corpus`).toBe(
      frozenText(file),
    );
  }
});
