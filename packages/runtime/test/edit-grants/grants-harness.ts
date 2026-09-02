import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach } from 'vitest';

/**
 * The shared fixtures of the edit-grants tests (#223): realpath'd temp
 * project roots (canonical by construction — /tmp is itself a symlink
 * on darwin) and a session factory. Digests are computed with node:crypto
 * directly, independently of the module under test.
 */

const scratchDirs: string[] = [];

/** A realpath'd temp directory standing in for a canonical project root. */
export async function makeProjectRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astroix-grants-')));
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
  return createHash('sha256').update(text).digest('hex');
}

/** Creates a directory under `root` (project-relative posix path), returning nothing. */
export async function makeDir(root: string, relative: string): Promise<void> {
  await mkdir(join(root, relative), { recursive: true });
}
