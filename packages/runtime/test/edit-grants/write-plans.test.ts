import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGrantTable, type GrantTable } from '../../edit-authority/grants/grant-table';
import { planEdit } from '../../edit-authority/planning/write-plans';
import { digestOf, makeDir, makeProjectRoot, session } from './grants-harness';

/**
 * The planning boundary (#223, ADR-0006 §6): the lift from a wire write
 * plan to a domain write plan. Every rejection family of the acceptance
 * criteria is exercised here — arbitrary paths never reach issuance
 * (that is the table's job, tested alongside), and this boundary adds
 * the wire/claim rejections: malformed plans, out-of-matrix operations,
 * tampered echoes (claim mismatch, including the display path), stale
 * and replayed grants — and the positive side: expected-hash and
 * expected-absent plans bound to the server's canonical truth.
 */

const CSS = '.hero { color: red; }';

async function cssGrant(root: string, table: GrantTable) {
  await mkdir(join(root, 'src/styles'), { recursive: true });
  await writeFile(join(root, 'src/styles/global.css'), CSS);
  const granted = await table.issue(
    {
      discovery: 'existing-text',
      kind: 'css',
      path: 'src/styles/global.css',
      revision: digestOf(CSS),
    },
    session('epoch-a', 1),
  );
  expect(granted.ok).toBe(true);
  return granted.ok ? granted.grant : null;
}

describe('planEdit — happy paths', () => {
  it('plans a css replace-contents edit onto the canonical server truth', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    expect(grant).not.toBeNull();
    if (grant === null) return;

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: '.hero { color: blue; }' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual({
      operation: 'replace-contents',
      resource: expect.objectContaining({
        canonicalRoot: root,
        kind: 'css',
        target: { type: 'existing', canonicalPath: join(root, 'src/styles/global.css') },
      }),
      contents: '.hero { color: blue; }',
    });
  });

  it('plans a css splice edit when the range fits the exact baseline', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'splice', grant, range: { start: 15, end: 18 }, replacement: 'blue' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.operation).toBe('splice');
    if (result.plan.operation === 'splice') {
      expect(result.plan.range).toEqual({ start: 15, end: 18 });
      expect(result.plan.replacement).toBe('blue');
    }
  });

  it('plans a content creation edit onto the contained canonical parent', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'new.md',
      },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'create-contents',
        grant: granted.grant,
        contents: '---\ntitle: New\n---\n',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual({
      operation: 'create-contents',
      resource: expect.objectContaining({
        baseline: { type: 'expected-absent' },
        target: {
          type: 'creation',
          canonicalParent: join(root, 'src/content/hero'),
          fileName: 'new.md',
        },
      }),
      contents: '---\ntitle: New\n---\n',
    });
  });
});

describe('planEdit — wire rejection', () => {
  it('rejects plans outside the closed write-plan contract', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    const unknownField = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: 'x', extra: true },
    });
    expect(unknownField).toEqual({ ok: false, code: 'invalid-plan', message: expect.any(String) });

    const missingGrant = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', contents: 'x' },
    });
    expect(missingGrant).toEqual({ ok: false, code: 'invalid-plan', message: expect.any(String) });

    const invertedRange = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'splice', grant, range: { start: 9, end: 3 }, replacement: 'x' },
    });
    expect(invertedRange).toEqual({ ok: false, code: 'invalid-plan', message: expect.any(String) });
  });

  it('rejects kind×operation combinations outside the species matrix before touching the table', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    // css creation is outside the species set (placement deferred, #203).
    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'create-contents',
        grant: { ...grant, operations: ['create-contents'] },
        contents: 'x',
      },
    });
    expect(result).toEqual({
      ok: false,
      code: 'operation-not-allowed',
      message: expect.any(String),
    });
  });

  it('rejects unknown grants — arbitrary tokens never plan', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'replace-contents',
        grant: { ...grant, token: 'an-arbitrary-forged-token-value-aaaaaaaaaaaaaa' },
        contents: 'x',
      },
    });
    expect(result).toEqual({ ok: false, code: 'unknown-grant', message: expect.any(String) });
  });

  it('rejects stale, cross-session plans', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    const nextGeneration = await planEdit(table, {
      session: session('epoch-a', 2),
      plan: { operation: 'replace-contents', grant, contents: 'x' },
    });
    expect(nextGeneration).toEqual({
      ok: false,
      code: 'cross-session',
      message: expect.any(String),
    });

    const nextEpoch = await planEdit(table, {
      session: session('epoch-b', 1),
      plan: { operation: 'replace-contents', grant, contents: 'x' },
    });
    expect(nextEpoch).toEqual({ ok: false, code: 'cross-session', message: expect.any(String) });
  });
});

describe('planEdit — display paths are presentation, never authority', () => {
  it('rejects a tampered display path as a claim mismatch', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'replace-contents',
        // Pointing the echo at a different file changes nothing about
        // what the server would write — but a drifted echo of ANY field
        // fails closed.
        grant: { ...grant, displayPath: 'src/styles/other.css' },
        contents: 'x',
      },
    });
    expect(result).toEqual({ ok: false, code: 'claim-mismatch', message: expect.any(String) });
  });

  it('rejects tampered baselines and operation lists as claim mismatches', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    const tamperedBaseline = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'replace-contents',
        grant: {
          ...grant,
          baseline: { type: 'sha256', sha256: digestOf('something else entirely') },
        },
        contents: 'x',
      },
    });
    expect(tamperedBaseline).toEqual({
      ok: false,
      code: 'claim-mismatch',
      message: expect.any(String),
    });

    const droppedOperation = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'replace-contents',
        grant: { ...grant, operations: ['splice'] },
        contents: 'x',
      },
    });
    expect(droppedOperation).toEqual({
      ok: false,
      code: 'claim-mismatch',
      message: expect.any(String),
    });
  });

  it('carries no canonical path on the wire grant — only the server truth does', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;
    expect(JSON.stringify(grant)).not.toContain(root);

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: 'x' },
    });
    expect(result.ok).toBe(true);
    // The domain plan is server-side truth and may carry the canonical
    // target; the wire grant never did.
    if (result.ok) {
      expect(JSON.stringify(result.plan)).toContain(join(root, 'src/styles/global.css'));
    }
  });
});

describe('planEdit — revision contract at plan time', () => {
  it('rejects a replayed grant after the world changed (expected-hash conflict)', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    // The world a successful write of this very plan would produce.
    await writeFile(join(root, 'src/styles/global.css'), '.hero { color: blue; }');

    const replay = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: '.hero { color: blue; }' },
    });
    expect(replay).toEqual({ ok: false, code: 'changed-baseline', message: expect.any(String) });
  });

  it('rejects the superseded grant after re-issuance bound a fresh revision', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    // The write landed, discovery re-ran, a follow-on grant was issued
    // for the new revision — exactly ADR-0006 §6's flow.
    const newCss = '.hero { color: blue; }';
    await writeFile(join(root, 'src/styles/global.css'), newCss);
    const followOn = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/global.css',
        revision: digestOf(newCss),
      },
      session('epoch-a', 1),
    );
    expect(followOn.ok).toBe(true);

    const stale = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: 'x' },
    });
    expect(stale).toEqual({ ok: false, code: 'superseded', message: expect.any(String) });

    if (followOn.ok) {
      const fresh = await planEdit(table, {
        session: session('epoch-a', 1),
        plan: { operation: 'replace-contents', grant: followOn.grant, contents: 'x' },
      });
      expect(fresh.ok).toBe(true);
    }
  });

  it('rejects a creation plan once the expected-absent slot filled', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'new.md',
      },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    await writeFile(join(root, 'src/content/hero/new.md'), '---\ntitle: Raced\n---\n');

    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'create-contents',
        grant: granted.grant,
        contents: '---\ntitle: Mine\n---\n',
      },
    });
    expect(result).toEqual({ ok: false, code: 'target-exists', message: expect.any(String) });
  });

  it('rejects a revoked grant before any write', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    expect(table.revoke(grant.token)).toBe(true);
    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: 'x' },
    });
    expect(result).toEqual({ ok: false, code: 'revoked', message: expect.any(String) });
  });

  it('rejects a vanished target at plan time', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const grant = await cssGrant(root, table);
    if (grant === null) return;

    await rm(join(root, 'src/styles/global.css'));
    const result = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'replace-contents', grant, contents: 'x' },
    });
    expect(result).toEqual({ ok: false, code: 'target-absent', message: expect.any(String) });
  });
});
