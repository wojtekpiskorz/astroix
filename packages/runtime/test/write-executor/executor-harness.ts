import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach } from 'vitest';
import type { GrantedResource, GrantTable } from '../../edit-authority/grants/grant-table';
import { createGrantTable } from '../../edit-authority/grants/grant-table';
import type { DomainWritePlan } from '../../edit-authority/planning/write-plans';
import { planEdit } from '../../edit-authority/planning/write-plans';

/**
 * The shared fixtures of the write-executor tests (#224): realpath'd temp
 * project roots (canonical by construction — /tmp is itself a symlink on
 * darwin), real D4 grant/planning pipelines for honest plans, and a
 * hand-bound resource builder for the adversarial shapes the planning
 * boundary would never mint (the executor fails closed on those by
 * contract). Digests are computed with node:crypto directly,
 * independently of the modules under test.
 */

const scratchDirs: string[] = [];

/** A realpath'd temp directory standing in for a canonical project root. */
export async function makeProjectRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astroix-write-executor-')));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A distinct session by epoch and generation. */
export function session(runtimeEpoch: string, generation: number): SessionRef {
  return { runtimeEpoch, generation };
}

/** SHA-256 hex over a string's utf8 bytes — the oracle for revision facts. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Creates a directory under `root` (project-relative posix path). */
export async function makeDir(root: string, relative: string): Promise<void> {
  await mkdir(join(root, relative), { recursive: true });
}

/**
 * Mints one css existing-text grant from the real D4 table and lifts a
 * replace-contents plan through the real planning boundary — the honest
 * plan pipeline the executor serves in production.
 */
export async function cssReplacePlan(
  table: GrantTable,
  sessionRef: SessionRef,
  path: string,
  currentText: string,
  nextText: string,
): Promise<DomainWritePlan> {
  const granted = await table.issue(
    { discovery: 'existing-text', kind: 'css', path, revision: digestOf(currentText) },
    sessionRef,
  );
  if (!granted.ok) throw new Error(`grant issuance failed: ${granted.code}`);
  const planned = await planEdit(table, {
    session: sessionRef,
    plan: { operation: 'replace-contents', grant: granted.grant, contents: nextText },
  });
  if (!planned.ok) throw new Error(`planning failed: ${planned.code}`);
  return planned.plan;
}

/**
 * A hand-bound granted resource for the adversarial shapes: every field
 * explicit and overridable, so the final-validation battery can bind
 * sessions, roots, operations, baselines, and targets the planning
 * boundary would refuse to mint — the executor must fail closed on each.
 */
export function boundResource(overrides: {
  canonicalRoot: string;
  sessionRef: SessionRef;
  operations?: readonly ('replace-contents' | 'splice' | 'create-contents')[];
  target:
    | { type: 'existing'; canonicalPath: string; sha256: string }
    | { type: 'creation'; canonicalParent: string; fileName: string };
}): GrantedResource {
  return {
    canonicalRoot: overrides.canonicalRoot,
    session: overrides.sessionRef,
    kind: 'css',
    operations: overrides.operations ?? ['replace-contents', 'splice'],
    displayPath: 'src/styles/adversarial.css',
    baseline:
      overrides.target.type === 'existing'
        ? { type: 'sha256', sha256: overrides.target.sha256 }
        : { type: 'expected-absent' },
    target:
      overrides.target.type === 'existing'
        ? { type: 'existing', canonicalPath: overrides.target.canonicalPath }
        : {
            type: 'creation',
            canonicalParent: overrides.target.canonicalParent,
            fileName: overrides.target.fileName,
          },
  };
}

/** A fresh real grant table over a temp root — the honest issuance pipeline. */
export async function openTable(root: string): Promise<GrantTable> {
  return createGrantTable(root);
}
