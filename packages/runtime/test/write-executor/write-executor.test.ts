import {
  chmod,
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWriteExecutor } from '../../edit-authority/executor/write-executor';
import { ExecutorFencedError } from '../../edit-authority/executor/write-outcomes';
import type { DomainWritePlan } from '../../edit-authority/planning/write-plans';
import { planEdit } from '../../edit-authority/planning/write-plans';
import {
  boundResource,
  cssReplacePlan,
  digestOf,
  makeDir,
  makeProjectRoot,
  openTable,
  session,
} from './executor-harness';

// @vitest-environment node — real filesystem over realpath'd temp roots; no DOM.
/**
 * The write-executor core lane (#224 focused tests): serialized ordering,
 * the full immediate-before-commit final-validation battery (containment,
 * symlink swaps, hard links, stale revisions, cross-session — every
 * rejection proves NO bytes moved), the commit disciplines (same-directory
 * temp + atomic replacement with mode preservation, exclusive creation,
 * byte-surgical splices), and the drain/fence lifecycle. Real files, real
 * fsync/rename — zero mocks; honest plans come through the real D4
 * grant+planning pipeline, adversarial shapes are hand-bound exactly
 * because the planning boundary would never mint them.
 */

const CSS = '.hero { color: red; }\n.body { margin: 0; }\n';

async function writeStyles(root: string, text = CSS): Promise<string> {
  await makeDir(root, 'src/styles');
  const path = join(root, 'src/styles/global.css');
  await writeFile(path, text, 'utf8');
  return path;
}

describe('serialized ordering', () => {
  it('executes accepted operations strictly in admission order — a chained pair both commits', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const first = 'a { top: 1; }\n';
    const middle = 'b { top: 1; }\n';
    const second = 'c { top: 1; }\n';
    const path = await writeStyles(root, first);
    // The first plan comes through the real pipeline; the second is
    // hand-bound against the bytes the FIRST will produce — real
    // issuance could not mint it (the table verifies current bytes), and
    // only admission-ordered execution lets both commit: out of order,
    // the second's final validation sees `first` and refuses.
    const planOne = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      first,
      middle,
    );
    const planTwo: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(middle) },
      }),
      contents: second,
    };
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const outcomeOne = executor.execute(planOne);
    const outcomeTwo = executor.execute(planTwo);
    expect(await outcomeOne).toEqual({ type: 'committed', revision: digestOf(middle) });
    expect(await outcomeTwo).toEqual({ type: 'committed', revision: digestOf(second) });
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(second);
    await executor.stop();
  });

  it('one accepted operation is terminal before the next starts: a stale second plan rejects, never writes over the first', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const current = 'p { color: red; }\n';
    await writeStyles(root, current);
    // Two plans BOTH bound to the same baseline: the first commits, the
    // second's final validation sees the first's bytes and refuses.
    const planOne = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      current,
      'p { color: blue; }\n',
    );
    const planTwo = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      current,
      'p { color: green; }\n',
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const outcomes = await Promise.all([executor.execute(planOne), executor.execute(planTwo)]);
    expect(outcomes[0]?.type).toBe('committed');
    expect(outcomes[1]).toEqual({
      type: 'rejected',
      code: 'changed-baseline',
      message: 'the resource no longer matches the grant\u2019s revision contract',
    });
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(
      'p { color: blue; }\n',
    );
    await executor.stop();
  });
});

describe('final validation — every rejection proves no bytes moved', () => {
  it('stale revision: the file changed after planning — changed-baseline, no write', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    await writeFile(join(root, 'src/styles/global.css'), '.hero { color: green; }\n', 'utf8');
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'changed-baseline',
      message: 'the resource no longer matches the grant\u2019s revision contract',
    });
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(
      '.hero { color: green; }\n',
    );
    await executor.stop();
  });

  it('hard link: a second link onto the target — hard-linked-target, no write', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const path = await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    await link(path, join(root, 'src/styles/hard-link.css'));
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'hard-linked-target',
      message: 'the target has more than one hard link',
    });
    expect(await readFile(path, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('symlink swap to an external target: containment refuses — target-moved, no write', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const outside = await makeProjectRoot();
    const outsideFile = join(outside, 'outside.css');
    await writeFile(outsideFile, CSS, 'utf8');
    const bound = join(root, 'src/styles/global.css');
    await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    // Swap the bound canonical file for a symlink pointing OUTSIDE the root.
    await rm(bound);
    await symlink(outsideFile, bound);
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'target-moved',
      message: 'the canonical target changed underneath the grant (containment or symlink drift)',
    });
    // The external target itself is untouched.
    expect(await readFile(outsideFile, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('symlink swap to another internal file: resolution drift refuses — target-moved, no write', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    await makeDir(root, 'src/styles');
    const other = join(root, 'src/styles/other.css');
    await writeFile(other, CSS, 'utf8');
    const bound = join(root, 'src/styles/global.css');
    await writeFile(bound, CSS, 'utf8');
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    // Swap the bound canonical for a symlink resolving INSIDE the root but
    // elsewhere: the grant bound this exact canonical path, not a neighbor.
    await rm(bound);
    await symlink(other, bound);
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'target-moved',
      message: 'the canonical target changed underneath the grant (containment or symlink drift)',
    });
    expect(await readFile(other, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('an internal symlink stays editable — the grant bound its resolved inside-root canonical, and the write lands there', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    await makeDir(root, 'src/styles');
    const real = join(root, 'src/styles/real.css');
    await writeFile(real, CSS, 'utf8');
    // The symlink is internal: its target resolves inside the root, so
    // issuance binds the RESOLVED canonical and the executor writes it.
    await symlink(real, join(root, 'src/styles/link.css'));
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/link.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'committed',
      revision: digestOf('.hero { color: blue; }\n'),
    });
    expect(await readFile(real, 'utf8')).toBe('.hero { color: blue; }\n');
    await executor.stop();
  });

  it('an external canonical target is denied containment even with a matching baseline — target-moved', async () => {
    const root = await makeProjectRoot();
    const outside = await makeProjectRoot();
    const outsideFile = join(outside, 'outside.css');
    await writeFile(outsideFile, CSS, 'utf8');
    const plan: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        target: { type: 'existing', canonicalPath: outsideFile, sha256: digestOf(CSS) },
      }),
      contents: '.hero { color: blue; }\n',
    };
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'target-moved',
      message: 'the canonical target changed underneath the grant (containment or symlink drift)',
    });
    expect(await readFile(outsideFile, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('cross-session plan never writes — cross-session, no write', async () => {
    const root = await makeProjectRoot();
    const path = await writeStyles(root, CSS);
    const plan: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(CSS) },
      }),
      contents: '.hero { color: blue; }\n',
    };
    // This executor serves generation 2 — the plan is bound to generation 1.
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 2) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'cross-session',
      message: 'the write plan is bound to another session',
    });
    expect(await readFile(path, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('plan bound to another canonical root — wrong-root, no write', async () => {
    const root = await makeProjectRoot();
    const otherRoot = await makeProjectRoot();
    const path = await writeStyles(root, CSS);
    const plan: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: otherRoot,
        sessionRef: session('epoch-a', 1),
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(CSS) },
      }),
      contents: '.hero { color: blue; }\n',
    };
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'wrong-root',
      message: 'the write plan is bound to another canonical project root',
    });
    expect(await readFile(path, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('operation outside the grant\u2019s allowed set — operation-not-allowed, no write', async () => {
    const root = await makeProjectRoot();
    const path = await writeStyles(root, CSS);
    const plan: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        operations: ['splice'],
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(CSS) },
      }),
      contents: '.hero { color: blue; }\n',
    };
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'operation-not-allowed',
      message: 'the operation is not among the grant\u2019s allowed operations',
    });
    expect(await readFile(path, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('replace-contents against a creation-target grant — operation-target-mismatch, no write', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content');
    const plan: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        operations: ['replace-contents', 'create-contents'],
        target: {
          type: 'creation',
          canonicalParent: join(root, 'src/content'),
          fileName: 'new.md',
        },
      }),
      contents: '---\ntitle: x\n---\n',
    };
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'operation-target-mismatch',
      message: 'the operation does not fit the grant\u2019s target species',
    });
    await executor.stop();
  });

  it('deleted target — target-absent; directory-in-place-of-file — not-a-file', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const path = await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    // A second, hand-bound copy of the same target for the second case.
    const handBound: DomainWritePlan = {
      operation: 'replace-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(CSS) },
      }),
      contents: '.hero { color: blue; }\n',
    };

    await rm(path);
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'target-absent',
      message: 'the granted target no longer exists',
    });

    await mkdir(path);
    expect(await executor.execute(handBound)).toEqual({
      type: 'rejected',
      code: 'not-a-file',
      message: 'the granted target is not a regular file',
    });
    await executor.stop();
  });

  it('creation slot filled — target-exists; parent removed — parent-absent; parent not a directory — parent-not-directory', async () => {
    const root = await makeProjectRoot();
    await makeDir(root, 'src/content');
    const creationPlan = (target: {
      canonicalParent: string;
      fileName: string;
    }): DomainWritePlan => ({
      operation: 'create-contents',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        operations: ['create-contents'],
        target: { type: 'creation', ...target },
      }),
      contents: '---\ntitle: new\n---\nbody\n',
    });
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });

    await writeFile(join(root, 'src/content/exists.md'), 'taken\n', 'utf8');
    expect(
      await executor.execute(
        creationPlan({ canonicalParent: join(root, 'src/content'), fileName: 'exists.md' }),
      ),
    ).toEqual({
      type: 'rejected',
      code: 'target-exists',
      message: 'the expected-absent creation target already exists',
    });
    expect(await readFile(join(root, 'src/content/exists.md'), 'utf8')).toBe('taken\n');

    expect(
      await executor.execute(
        creationPlan({ canonicalParent: join(root, 'src/gone'), fileName: 'new.md' }),
      ),
    ).toEqual({
      type: 'rejected',
      code: 'parent-absent',
      message: 'the creation parent no longer exists',
    });

    await writeFile(join(root, 'src/content/file.md'), 'x', 'utf8');
    expect(
      await executor.execute(
        creationPlan({ canonicalParent: join(root, 'src/content/file.md'), fileName: 'new.md' }),
      ),
    ).toEqual({
      type: 'rejected',
      code: 'parent-not-directory',
      message: 'the creation parent is not a directory',
    });
    await executor.stop();
  });

  it('splice range beyond the verified text — range-outside-baseline, no write', async () => {
    const root = await makeProjectRoot();
    const path = await writeStyles(root, CSS);
    const plan: DomainWritePlan = {
      operation: 'splice',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        operations: ['splice'],
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(CSS) },
      }),
      range: { start: 4, end: CSS.length + 10 },
      replacement: 'x',
    };
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(plan)).toEqual({
      type: 'rejected',
      code: 'range-outside-baseline',
      message: 'the splice range does not fit the verified baseline contents',
    });
    expect(await readFile(path, 'utf8')).toBe(CSS);
    await executor.stop();
  });

  it('an inverted splice range rejects — never duplicates bytes, never reports committed', async () => {
    const root = await makeProjectRoot();
    const path = await writeStyles(root, CSS);
    const splicePlan = (range: { start: number; end: number }): DomainWritePlan => ({
      operation: 'splice',
      resource: boundResource({
        canonicalRoot: root,
        sessionRef: session('epoch-a', 1),
        operations: ['splice'],
        target: { type: 'existing', canonicalPath: path, sha256: digestOf(CSS) },
      }),
      range,
      replacement: 'x',
    });
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    // Both fit inside the verified text with a matching digest — only the
    // ORDERING is wrong. Slicing an inverted window would duplicate the
    // overlap (slice(0,30) + 'x' + slice(12)); the core refuses instead.
    const inverted = await executor.execute(splicePlan({ start: 30, end: 12 }));
    expect(inverted).toEqual({
      type: 'rejected',
      code: 'range-outside-baseline',
      message: 'the splice range does not fit the verified baseline contents',
    });
    // The protocol's sourceRange is strict (`start < end`): an empty range
    // is a shape planning would never mint — same fence, same refusal.
    const empty = await executor.execute(splicePlan({ start: 12, end: 12 }));
    expect(empty).toEqual({
      type: 'rejected',
      code: 'range-outside-baseline',
      message: 'the splice range does not fit the verified baseline contents',
    });
    expect(await readFile(path, 'utf8')).toBe(CSS);
    await executor.stop();
  });
});

describe('commit disciplines', () => {
  it('existing replacement: exact bytes land, mode preserved, no temp leftovers', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const next = '.hero { color: blue; }\n';
    const path = await writeStyles(root, CSS);
    await chmod(path, 0o640);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      next,
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const outcome = await executor.execute(plan);
    expect(outcome).toEqual({ type: 'committed', revision: digestOf(next) });
    expect(await readFile(path, 'utf8')).toBe(next);
    // The replacement preserves the developer's file mode exactly (fchmod, not umask).
    expect((await stat(path)).mode & 0o7777).toBe(0o640);
    const leftovers = (await readdir(join(root, 'src/styles'))).filter((name) =>
      name.startsWith('.astroix-write-'),
    );
    expect(leftovers).toEqual([]);
    await executor.stop();
  });

  it('a temp-write failure leaves the original intact and no temp behind — failed, write-failed', async () => {
    const root = await makeProjectRoot();
    const next = '.hero { color: blue; }\n';
    const stylesDir = join(root, 'src/styles');
    const path = await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      await openTable(root),
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      next,
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    await chmod(stylesDir, 0o500); // the same-directory temp cannot be created
    try {
      expect(await executor.execute(plan)).toEqual({
        type: 'failed',
        code: 'write-failed',
        message: 'the temporary file could not be written and synced',
      });
      expect(await readFile(path, 'utf8')).toBe(CSS);
    } finally {
      await chmod(stylesDir, 0o755);
    }
    expect((await readdir(stylesDir)).filter((name) => name.startsWith('.astroix-write-'))).toEqual(
      [],
    );
    await executor.stop();
  });

  it('splice: byte-surgical — every byte outside the window identical', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    await writeStyles(root, CSS);
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
    if (!granted.ok) return;
    const planned = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: {
        operation: 'splice',
        grant: granted.grant,
        range: { start: CSS.indexOf('red'), end: CSS.indexOf('red') + 3 },
        replacement: 'blue',
      },
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const expected = CSS.replace('red', 'blue');
    expect(await executor.execute(planned.plan)).toEqual({
      type: 'committed',
      revision: digestOf(expected),
    });
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(expected);
    await executor.stop();
  });

  it('creation: exclusive creation lands the exact bytes with the resulting revision', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    await makeDir(root, 'src/content');
    const contents = '---\ntitle: New entry\n---\nHello.\n';
    const granted = await table.issue(
      {
        discovery: 'creation',
        kind: 'content',
        parentPath: 'src/content',
        fileName: 'new-entry.md',
      },
      session('epoch-a', 1),
    );
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    const planned = await planEdit(table, {
      session: session('epoch-a', 1),
      plan: { operation: 'create-contents', grant: granted.grant, contents },
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    expect(await executor.execute(planned.plan)).toEqual({
      type: 'committed',
      revision: digestOf(contents),
    });
    expect(await readFile(join(root, 'src/content/new-entry.md'), 'utf8')).toBe(contents);
    await executor.stop();
  });
});

describe('drain and fence lifecycle', () => {
  it('stop fences admission, drains accepted work to terminal, then closes — idempotent', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    const next = '.hero { color: blue; }\n';
    await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      next,
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });

    const inFlight = executor.execute(plan); // accepted before the stop
    const stopping = executor.stop();
    expect(await inFlight).toEqual({ type: 'committed', revision: digestOf(next) });
    // The stop settles only after the drain closed the executor.
    await expect(stopping).resolves.toEqual({ outcome: 'drained', settled: 1 });
    expect(executor.state).toBe('closed');
    await expect(executor.stop()).resolves.toEqual({ outcome: 'drained', settled: 1 });
    await expect(executor.closed).resolves.toEqual({ outcome: 'drained', settled: 1 });
    await expect(executor.execute(plan)).rejects.toBeInstanceOf(ExecutorFencedError);
  });

  it('work submitted after the fence was never accepted — ExecutorFencedError, no outcome, no write', async () => {
    const root = await makeProjectRoot();
    const table = await openTable(root);
    await writeStyles(root, CSS);
    const plan = await cssReplacePlan(
      table,
      session('epoch-a', 1),
      'src/styles/global.css',
      CSS,
      '.hero { color: blue; }\n',
    );
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    await executor.stop();
    await expect(executor.execute(plan)).rejects.toBeInstanceOf(ExecutorFencedError);
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(CSS);
  });
});
