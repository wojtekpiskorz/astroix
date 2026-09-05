import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SourceFile } from '@wojciechpiskorz/astroix-core';
import { stylesJoinRejected } from './effective-selector-join';

/**
 * The styles join's static-truth reader (#226): walks the managed
 * project's default source directory for `.astro`/`.css` files and reads
 * them as `SourceFile`s — the inputs the pure indexer
 * (`packages/core` buildCssIndex, the edit truth) consumes. Project-
 * relative posix paths only; an absent or unreadable source directory
 * fails closed as a seam rejection instead of leaking a filesystem
 * error that names the root (ADR-0006 §7 output hygiene).
 *
 * Every file is read EXACTLY once, as bytes: the utf-8 string feeds the
 * index, and the same read's SHA-256 digest (`fileDigests`, #405) is the
 * walk-time freshness proof the converged payload publishes and the
 * write enrichment re-verifies against a later read — one read, so the
 * digest is byte-coherent with the indexed string by construction
 * (never a second read's TOCTOU).
 *
 * Pre-alpha scope limitation (#302, owner ruling 2026-09-03): the walk
 * covers the project's DEFAULT source directory (`src/`) only — a
 * configured custom `srcDir` is out of scope until such projects enter
 * supported territory (deriving the walk root from the route
 * component's prefix is the deferred remedy; it wants #301's
 * certification leg and a custom-srcDir fixture). A custom-srcDir
 * project still fails closed on both arms: with no `src/` this walk
 * rejects, and with a style-free `src/` while the styles live under the
 * custom dir, the join's hollow-payload cross-check
 * (`effective-selector-join.ts`) rejects instead of minting a silent
 * revision — the rejection names the real condition (the walk and the
 * compiler observed different source trees), never a hollow payload.
 */

const SEAM_JOIN_SOURCE_WALK = 'styles join project CSS source walk';

/** The walked static truth: the pure index's sources plus each file's walk-time digest (#405). */
export interface ProjectCssWalk {
  /** The sources the pure indexer consumes — contents utf-8-decoded from the digested bytes. */
  readonly sources: readonly SourceFile[];
  /**
   * Per project-relative posix file: SHA-256 hex over the exact bytes
   * `contents` was decoded from at walk time — the indexed truth's own
   * digest, published by the converged inspection for the enrichment's
   * re-verification (same-length disk drift is a mismatch, never a fit).
   */
  readonly fileDigests: Readonly<Record<string, string>>;
}

/** Reads the project's CSS sources and their digests, in deterministic walk order. */
export async function readProjectCssSources(projectRoot: string): Promise<ProjectCssWalk> {
  let files: string[];
  try {
    files = await collectSourceFiles(join(projectRoot, 'src'));
  } catch (cause) {
    throw stylesJoinRejected(
      SEAM_JOIN_SOURCE_WALK,
      'a readable project source directory',
      'an absent or unreadable project source directory',
      cause,
    );
  }
  const sources: SourceFile[] = [];
  const fileDigests: Record<string, string> = {};
  for (const file of files) {
    const bytes = await readFile(file);
    const relativeFile = relative(projectRoot, file).split(sep).join('/');
    sources.push({ file: relativeFile, contents: bytes.toString('utf8') });
    fileDigests[relativeFile] = createHash('sha256').update(bytes).digest('hex');
  }
  return { sources, fileDigests };
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)));
    else if (entry.name.endsWith('.astro') || entry.name.endsWith('.css')) files.push(path);
  }
  return files.sort();
}
