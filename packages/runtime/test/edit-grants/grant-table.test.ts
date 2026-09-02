import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resourceGrantSchema } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createGrantTable } from '../../edit-authority/grants/grant-table';
import { digestOf, makeDir, makeProjectRoot, session } from './grants-harness';

/**
 * The grant table (#223, ADR-0006 §6): issuance from discovered
 * resources over a real canonical root, the lifecycle validations
 * (stale / revoked / mismatched / cross-session / wrong-kind /
 * superseded), and the world verification of the revision contract.
 * Authority is never a client path: every issuance input is a
 * discovered-resource fact, and containment is judged on realpath
 * results, never lexical spelling.
 */

const CSS = '.hero { color: red; }';

async function writeCss(root: string, relative: string, text = CSS): Promise<string> {
  await mkdir(dirname(join(root, relative)), { recursive: true });
  await writeFile(join(root, relative), text);
  return digestOf(text);
}

describe('createGrantTable', () => {
  it('rejects a root that cannot be re-resolved, with a sanitized message', async () => {
    const root = await makeProjectRoot();
    await rm(root, { recursive: true });
    await expect(createGrantTable(root)).rejects.toThrow(
      'the canonical project root is unavailable or is not a directory',
    );
  });
});

describe('issue — existing text', () => {
  it('issues an opaque wire grant bound to the discovered revision', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);

    const result = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The wire shape is exactly the protocol's closed grant contract.
    expect(() => resourceGrantSchema.parse(result.grant)).not.toThrow();
    expect(result.grant.kind).toBe('css');
    expect(result.grant.operations).toEqual(['replace-contents', 'splice']);
    expect(result.grant.displayPath).toBe('src/styles/global.css');
    expect(result.grant.baseline).toEqual({ type: 'sha256', sha256: revision });
  });

  it('never discloses the canonical root on the wire', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const result = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.grant)).not.toContain(root);
  });

  it('binds the canonical root, session, and resolved target server-side', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 4),
    );
    expect(granted.ok).toBe(true);
    const authorized = table.authorize({
      token: granted.ok ? granted.grant.token : '',
      session: session('epoch-a', 4),
      kind: 'css',
      operation: 'splice',
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.resource.canonicalRoot).toBe(root);
    expect(authorized.resource.session).toEqual(session('epoch-a', 4));
    expect(authorized.resource.target).toEqual({
      type: 'existing',
      canonicalPath: join(root, 'src/styles/global.css'),
    });
  });

  it('issues content-kind grants with the content species set', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    await writeFile(join(root, 'src/content/hero/first.md'), '---\ntitle: First\n---\n');
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'content',
        path: 'src/content/hero/first.md',
        revision: digestOf('---\ntitle: First\n---\n'),
      },
      session('epoch-a', 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.kind).toBe('content');
    expect(result.grant.operations).toEqual(['replace-contents', 'create-contents']);
  });

  it('rejects arbitrary paths: traversal, absolute, and backslash forms', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    for (const path of ['../escape.css', '/etc/passwd', 'src\\styles.css', 'src/../..']) {
      const result = await table.issue(
        { discovery: 'existing-text', kind: 'css', path, revision },
        session('epoch-a', 1),
      );
      expect(result).toEqual({
        ok: false,
        code: 'invalid-resource-path',
        message: expect.any(String),
      });
    }
  });

  it('rejects a lexically-inside symlink whose resolved target is outside the root', async () => {
    const root = await makeProjectRoot();
    const outside = await makeProjectRoot();
    await writeFile(join(outside, 'secret.css'), CSS);
    await symlink(outside, join(root, 'link'));
    const table = await createGrantTable(root);

    const result = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'link/secret.css',
        revision: digestOf(CSS),
      },
      session('epoch-a', 1),
    );
    // The spelling lives inside the root; the canonical target does not.
    // Lexical containment would have granted this.
    expect(result).toEqual({
      ok: false,
      code: 'outside-root',
      message: expect.any(String),
    });
  });

  it('grants an internal symlink, bound to its resolved canonical target', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/real.css');
    await symlink(join(root, 'src/styles/real.css'), join(root, 'src/styles/alias.css'));
    const table = await createGrantTable(root);

    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/alias.css', revision },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    const authorized = table.authorize({
      token: granted.ok ? granted.grant.token : '',
      session: session('epoch-a', 1),
      kind: 'css',
      operation: 'replace-contents',
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.resource.target).toEqual({
      type: 'existing',
      canonicalPath: join(root, 'src/styles/real.css'),
    });
    // The display path stays the discovered spelling — presentation only.
    expect(authorized.resource.displayPath).toBe('src/styles/alias.css');
  });

  it('rejects a hard-linked target (nlink > 1)', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/styles');
    await writeFile(join(root, 'src/styles/global.css'), CSS);
    await link(join(root, 'src/styles/global.css'), join(root, 'src/styles/hard.css'));
    const table = await createGrantTable(root);

    const result = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/global.css',
        revision: digestOf(CSS),
      },
      session('epoch-a', 1),
    );
    expect(result).toEqual({
      ok: false,
      code: 'hard-linked-target',
      message: expect.any(String),
    });
  });

  it('rejects a directory masquerading as a text resource', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/styles');
    const table = await createGrantTable(root);
    const result = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles', revision: digestOf(CSS) },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'not-a-file', message: expect.any(String) });
  });

  it('rejects a stale discovery revision (changed bytes)', async () => {
    const root = await makeProjectRoot();
    await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/global.css',
        revision: digestOf('.hero { color: blue; }'),
      },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'revision-mismatch', message: expect.any(String) });
  });

  it('rejects a vanished target', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/gone.css',
        revision: digestOf(CSS),
      },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'target-absent', message: expect.any(String) });
  });

  it('rejects operation sets outside the kind species or empty', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    for (const operations of [['create-contents'], [], ['splice', 'splice']] as const) {
      const css = await table.issue(
        {
          discovery: 'existing-text',
          kind: 'css',
          path: 'src/styles/global.css',
          revision,
          operations,
        },
        session('epoch-a', 1),
      );
      expect(css).toEqual({ ok: false, code: 'invalid-operations', message: expect.any(String) });
    }
    const entry = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'content',
        path: 'src/styles/global.css',
        revision,
        operations: ['splice'],
      },
      session('epoch-a', 1),
    );
    expect(entry).toEqual({ ok: false, code: 'invalid-operations', message: expect.any(String) });
  });

  it('honors a valid operation narrowing', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/global.css',
        revision,
        operations: ['replace-contents'],
      },
      session('epoch-a', 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.operations).toEqual(['replace-contents']);
  });
});

describe('issue — creation', () => {
  it('issues an expected-absent creation grant with a contained canonical parent', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);

    const result = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'new.md',
      },
      session('epoch-a', 2),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => resourceGrantSchema.parse(result.grant)).not.toThrow();
    expect(result.grant.baseline).toEqual({ type: 'expected-absent' });
    expect(result.grant.displayPath).toBe('src/content/hero/new.md');
    expect(result.grant.operations).toEqual(['create-contents']);

    const authorized = table.authorize({
      token: result.grant.token,
      session: session('epoch-a', 2),
      kind: 'content',
      operation: 'create-contents',
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.resource.target).toEqual({
      type: 'creation',
      canonicalParent: join(root, 'src/content/hero'),
      fileName: 'new.md',
    });
  });

  it('accepts the project root itself as a creation parent', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const result = await table.issue(
      { discovery: 'creation', kind: 'content', parentPath: '.', fileName: 'root-level.md' },
      session('epoch-a', 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authorized = table.authorize({
      token: result.grant.token,
      session: session('epoch-a', 1),
      kind: 'content',
      operation: 'create-contents',
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.resource.target.type === 'creation').toBe(true);
  });

  it('rejects file names that are not one safe segment', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);
    for (const fileName of ['nested/name.md', '..', '.', '', 'a\\b.md']) {
      const result = await table.issue(
        { discovery: 'creation', kind: 'content', parentPath: 'src/content/hero', fileName },
        session('epoch-a', 1),
      );
      expect(result).toEqual({
        ok: false,
        code: 'invalid-resource-path',
        message: expect.any(String),
      });
    }
  });

  it('rejects a creation parent that resolves outside the root', async () => {
    const root = await makeProjectRoot();
    const outside = await makeProjectRoot();
    await symlink(outside, join(root, 'outside-link'));
    const table = await createGrantTable(root);
    const result = await table.issue(
      { discovery: 'creation', kind: 'content', parentPath: 'outside-link', fileName: 'new.md' },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'parent-outside-root', message: expect.any(String) });
  });

  it('rejects traversal parent paths and non-directory parents', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src');
    await writeFile(join(root, 'src/plain.css'), CSS);
    const table = await createGrantTable(root);

    const traversal = await table.issue(
      { discovery: 'creation', kind: 'content', parentPath: '../elsewhere', fileName: 'new.md' },
      session('epoch-a', 1),
    );
    expect(traversal).toEqual({
      ok: false,
      code: 'invalid-resource-path',
      message: expect.any(String),
    });

    const fileParent = await table.issue(
      { discovery: 'creation', kind: 'content', parentPath: 'src/plain.css', fileName: 'new.md' },
      session('epoch-a', 1),
    );
    expect(fileParent).toEqual({
      ok: false,
      code: 'parent-not-directory',
      message: expect.any(String),
    });
  });

  it('rejects a vanished creation parent at issuance', async () => {
    const root = await makeProjectRoot();
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/gone',
        fileName: 'new.md',
      },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'parent-absent', message: expect.any(String) });
  });

  it('rejects a creation slot that is not expected-absent', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    await writeFile(join(root, 'src/content/hero/taken.md'), 'taken');
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'taken.md',
      },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'target-exists', message: expect.any(String) });
  });

  it('rejects creation operation sets other than create-contents', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);
    const result = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'new.md',
        operations: ['replace-contents'],
      },
      session('epoch-a', 1),
    );
    expect(result).toEqual({ ok: false, code: 'invalid-operations', message: expect.any(String) });
  });
});

describe('authorize', () => {
  it('rejects arbitrary tokens and tokens from another table', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);

    expect(
      table.authorize({
        token: 'not-a-token',
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'splice',
      }),
    ).toEqual({ ok: false, code: 'unknown-grant', message: expect.any(String) });

    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    // A second table over the same root is a different grant universe.
    const otherTable = await createGrantTable(root);
    expect(
      otherTable.authorize({
        token: granted.ok ? granted.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'splice',
      }),
    ).toEqual({ ok: false, code: 'unknown-grant', message: expect.any(String) });
  });

  it('rejects cross-session use: generation bump and epoch change', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    const token = granted.ok ? granted.grant.token : '';

    expect(
      table.authorize({ token, session: session('epoch-a', 2), kind: 'css', operation: 'splice' }),
    ).toEqual({ ok: false, code: 'cross-session', message: expect.any(String) });
    expect(
      table.authorize({ token, session: session('epoch-b', 1), kind: 'css', operation: 'splice' }),
    ).toEqual({ ok: false, code: 'cross-session', message: expect.any(String) });
  });

  it('rejects revoked grants, and double revocation reports false', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    const token = granted.ok ? granted.grant.token : '';

    expect(table.revoke(token)).toBe(true);
    expect(table.revoke(token)).toBe(false);
    expect(
      table.authorize({ token, session: session('epoch-a', 1), kind: 'css', operation: 'splice' }),
    ).toEqual({ ok: false, code: 'revoked', message: expect.any(String) });
  });

  it('supersedes the previous grant for the same target and session at re-issue', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const first = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    const second = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Fresh per-activation value: the re-issued grant is a new token.
    expect(second.ok && second.grant.token).not.toBe(first.ok ? first.grant.token : '');
    expect(
      table.authorize({
        token: first.ok ? first.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'splice',
      }),
    ).toEqual({ ok: false, code: 'superseded', message: expect.any(String) });
    expect(
      table.authorize({
        token: second.ok ? second.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'splice',
      }).ok,
    ).toBe(true);
  });

  it('supersedes the previous creation grant for the same slot and session', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);
    const first = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'new.md',
      },
      session('epoch-a', 1),
    );
    const second = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content/hero',
        fileName: 'new.md',
      },
      session('epoch-a', 1),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(
      table.authorize({
        token: first.ok ? first.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'content',
        operation: 'create-contents',
      }),
    ).toEqual({ ok: false, code: 'superseded', message: expect.any(String) });
    expect(
      table.authorize({
        token: second.ok ? second.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'content',
        operation: 'create-contents',
      }).ok,
    ).toBe(true);
  });

  it('keeps grants of other targets, other sessions, and other target types active', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    await writeCss(root, 'src/styles/other.css', '.other { color: blue; }');
    await makeDir(root, 'src/content/hero');
    const table = await createGrantTable(root);

    const a = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    // Same target, different session: supersession is per-session.
    await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-b', 1),
    );
    expect(
      table.authorize({
        token: a.ok ? a.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'splice',
      }).ok,
    ).toBe(true);

    // Different target, same session.
    const other = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/other.css',
        revision: digestOf('.other { color: blue; }'),
      },
      session('epoch-a', 1),
    );
    expect(
      table.authorize({
        token: other.ok ? other.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'splice',
      }).ok,
    ).toBe(true);

    // Same path, creation type: a different target identity, both live.
    const creation = await table.issue(
      { discovery: 'creation', kind: 'content', parentPath: 'src/content/hero', fileName: 'n.md' },
      session('epoch-a', 1),
    );
    expect(
      table.authorize({
        token: creation.ok ? creation.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'content',
        operation: 'create-contents',
      }).ok,
    ).toBe(true);
  });

  it('rejects wrong-kind and unpermitted operations', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    const token = granted.ok ? granted.grant.token : '';

    expect(
      table.authorize({
        token,
        session: session('epoch-a', 1),
        kind: 'content',
        operation: 'splice',
      }),
    ).toEqual({ ok: false, code: 'wrong-kind', message: expect.any(String) });
    expect(
      table.authorize({
        token,
        session: session('epoch-a', 1),
        kind: 'css',
        operation: 'create-contents',
      }),
    ).toEqual({ ok: false, code: 'operation-not-allowed', message: expect.any(String) });
  });

  it('revokes every grant of one session and only that session', async () => {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    await writeCss(root, 'src/styles/other.css', '.other { color: blue; }');
    const table = await createGrantTable(root);
    await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    const survivor = await table.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/other.css',
        revision: digestOf('.other { color: blue; }'),
      },
      session('epoch-b', 9),
    );
    // Supersede the first epoch-a grant so exactly one dies.
    await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );

    expect(table.revokeSession(session('epoch-a', 1))).toBe(1);
    expect(
      table.authorize({
        token: survivor.ok ? survivor.grant.token : '',
        session: session('epoch-b', 9),
        kind: 'css',
        operation: 'splice',
      }).ok,
    ).toBe(true);
  });
});

describe('verify', () => {
  async function issuedCss() {
    const root = await makeProjectRoot();
    const revision = await writeCss(root, 'src/styles/global.css');
    const table = await createGrantTable(root);
    const granted = await table.issue(
      { discovery: 'existing-text', kind: 'css', path: 'src/styles/global.css', revision },
      session('epoch-a', 1),
    );
    const authorized = table.authorize({
      token: granted.ok ? granted.grant.token : '',
      session: session('epoch-a', 1),
      kind: 'css',
      operation: 'splice',
    });
    expect(authorized.ok).toBe(true);
    return { root, table, resource: authorized.ok ? authorized.resource : null };
  }

  it('returns the verified current text for an unchanged existing target', async () => {
    const { table, resource } = await issuedCss();
    expect(resource).not.toBeNull();
    if (resource === null) return;
    const world = await table.verify(resource);
    expect(world).toEqual({ ok: true, text: CSS });
  });

  it('fails a changed baseline (the write-once replay case)', async () => {
    const { root, table, resource } = await issuedCss();
    if (resource === null) return;
    // The world a successful write would produce: same file, new bytes.
    await writeFile(join(root, 'src/styles/global.css'), '.hero { color: blue; }');
    expect(await table.verify(resource)).toEqual({
      ok: false,
      code: 'changed-baseline',
      message: expect.any(String),
    });
  });

  it('fails a vanished target and a symlink-swapped one', async () => {
    const moved = await issuedCss();
    if (moved.resource !== null) {
      await rm(join(moved.root, 'src/styles/global.css'));
      expect(await moved.table.verify(moved.resource)).toEqual({
        ok: false,
        code: 'target-absent',
        message: expect.any(String),
      });
    }

    const swapped = await issuedCss();
    if (swapped.resource !== null) {
      const outside = await makeProjectRoot();
      await writeFile(join(outside, 'elsewhere.css'), CSS);
      await rm(join(swapped.root, 'src/styles/global.css'));
      await symlink(join(outside, 'elsewhere.css'), join(swapped.root, 'src/styles/global.css'));
      expect(await swapped.table.verify(swapped.resource)).toEqual({
        ok: false,
        code: 'target-moved',
        message: expect.any(String),
      });
    }
  });

  it('fails a target replaced by a directory or a hard-linked twin', async () => {
    const asDir = await issuedCss();
    if (asDir.resource !== null) {
      await rm(join(asDir.root, 'src/styles/global.css'));
      await mkdir(join(asDir.root, 'src/styles/global.css'));
      expect(await asDir.table.verify(asDir.resource)).toEqual({
        ok: false,
        code: 'not-a-file',
        message: expect.any(String),
      });
    }

    const asLink = await issuedCss();
    if (asLink.resource !== null) {
      await link(
        join(asLink.root, 'src/styles/global.css'),
        join(asLink.root, 'src/styles/twin.css'),
      );
      expect(await asLink.table.verify(asLink.resource)).toEqual({
        ok: false,
        code: 'hard-linked-target',
        message: expect.any(String),
      });
    }
  });

  it('fails closed on a hand-built incoherent resource', async () => {
    const { table, resource } = await issuedCss();
    if (resource === null) return;
    // An existing target claiming an expected-absent contract (the
    // direct-call misuse shape) fails rather than being read.
    const incoherent = { ...resource, baseline: { type: 'expected-absent' } as const };
    expect(await table.verify(incoherent)).toEqual({
      ok: false,
      code: 'changed-baseline',
      message: expect.any(String),
    });
  });

  it('verifies creation slots absent until they exist', async () => {
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
    const authorized = table.authorize({
      token: granted.ok ? granted.grant.token : '',
      session: session('epoch-a', 1),
      kind: 'content',
      operation: 'create-contents',
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    expect(await table.verify(authorized.resource)).toEqual({ ok: true, text: null });

    await writeFile(join(root, 'src/content/hero/new.md'), 'appeared');
    expect(await table.verify(authorized.resource)).toEqual({
      ok: false,
      code: 'target-exists',
      message: expect.any(String),
    });
  });

  it('fails a creation slot whose parent vanished or drifted', async () => {
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
    const authorized = table.authorize({
      token: granted.ok ? granted.grant.token : '',
      session: session('epoch-a', 1),
      kind: 'content',
      operation: 'create-contents',
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    await rm(join(root, 'src/content/hero'), { recursive: true });
    expect(await table.verify(authorized.resource)).toEqual({
      ok: false,
      code: 'parent-absent',
      message: expect.any(String),
    });
  });

  it('fails a creation slot whose parent became a file or a symlinked detour', async () => {
    async function issuedCreation() {
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
      const authorized = table.authorize({
        token: granted.ok ? granted.grant.token : '',
        session: session('epoch-a', 1),
        kind: 'content',
        operation: 'create-contents',
      });
      expect(authorized.ok).toBe(true);
      return { root, table, resource: authorized.ok ? authorized.resource : null };
    }

    const asFile = await issuedCreation();
    if (asFile.resource !== null) {
      await rm(join(asFile.root, 'src/content/hero'), { recursive: true });
      await writeFile(join(asFile.root, 'src/content/hero'), 'now a file');
      expect(await asFile.table.verify(asFile.resource)).toEqual({
        ok: false,
        code: 'target-moved',
        message: expect.any(String),
      });
    }

    const detoured = await issuedCreation();
    if (detoured.resource !== null) {
      const outside = await makeProjectRoot();
      await rm(join(detoured.root, 'src/content/hero'), { recursive: true });
      await symlink(outside, join(detoured.root, 'src/content/hero'));
      expect(await detoured.table.verify(detoured.resource)).toEqual({
        ok: false,
        code: 'target-moved',
        message: expect.any(String),
      });
    }
  });
});
