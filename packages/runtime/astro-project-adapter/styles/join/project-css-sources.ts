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
 */

const SEAM_JOIN_SOURCE_WALK = 'styles join project CSS source walk';

/** Reads the project's CSS sources for the static index, in deterministic walk order. */
export async function readProjectCssSources(projectRoot: string): Promise<SourceFile[]> {
  let files: string[];
  try {
    files = await collectSourceFiles(join(projectRoot, 'src'));
  } catch (cause) {
    throw stylesJoinRejected(
      SEAM_JOIN_SOURCE_WALK,
      'a readable project source directory',
      'an absent or unreadable project source directory',
      { cause },
    );
  }
  const sources: SourceFile[] = [];
  for (const file of files) {
    sources.push({
      file: relative(projectRoot, file).split(sep).join('/'),
      contents: await readFile(file, 'utf8'),
    });
  }
  return sources;
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
