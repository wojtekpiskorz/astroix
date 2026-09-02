import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type EntryDraft, parseEntryDraft } from '@wojciechpiskorz/astroix-core';
import type { AdapterError } from '../adapter-error';
import { seamRejection } from '../adapter-error';
import { CONTENT_CONFIG_MODULE, SEAM_CONTENT_CONFIG } from './content-probes';

/**
 * The per-entry and per-config baseline reads (#228): the source files'
 * bytes — the raw truth's anchors — read once per pass, giving the
 * SHA-256 revisions (ADR-0006 §6's exact baseline for existing
 * resources), the raw frontmatter the project's actual schema validates
 * against (the same space Astro parses and safe-parses in its content
 * layer), and the content config module's own bytes (the
 * schema-semantics digest input — defaults, refinements, and transform
 * bodies live there, not in the walked field tree). Files are addressed
 * ONLY through the project's own discovered/served paths under the
 * canonical project root — never a client-selected path, never a
 * directory walk.
 */

/** What one entry's source file yielded. */
export interface EntryFileBaseline {
  /** SHA-256 hex over the file's bytes — the resource revision / grant baseline. */
  readonly revision: string;
  /** The raw file parse (core's draft shape); null when the frontmatter does not parse (mid-edit breakage). */
  readonly raw: EntryDraft | null;
}

/**
 * Reads one entry's baseline. The raw parse is null (and the revision
 * still served) when the frontmatter does not parse — an IDE-mid-edit
 * file keeps its byte baseline while its validation truth is unknown,
 * and the dev server's watcher owns convergence. The file being absent
 * reads as null on both legs — the sync race where the store still
 * serves a just-deleted entry — while any other read failure fails
 * closed so a broken read never masquerades as a missing file.
 */
export async function readEntryBaseline(
  projectRoot: string,
  filePath: string,
): Promise<EntryFileBaseline | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(projectRoot, filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw baselineRejection(filePath, error);
  }
  return {
    revision: createHash('sha256').update(bytes).digest('hex'),
    raw: parseEntryDraft(bytes.toString('utf8')),
  };
}

/**
 * The content config module's byte baseline — the digest input that
 * makes the revision contract cover schema SEMANTICS, not just the
 * walked field shape. Read after the pass already imported the module
 * through the runner, so a mid-pass disappearance is the same
 * invalidation race the watcher owns — it fails closed, never silently.
 */
export async function readConfigBaseline(projectRoot: string): Promise<string> {
  try {
    const bytes = await readFile(join(projectRoot, CONTENT_CONFIG_MODULE));
    return createHash('sha256').update(bytes).digest('hex');
  } catch (cause) {
    throw seamRejection(
      SEAM_CONTENT_CONFIG,
      'fail-closed private',
      `a readable content config module (${CONTENT_CONFIG_MODULE})`,
      'a read rejection',
      cause,
    );
  }
}

function baselineRejection(filePath: string, cause: unknown): AdapterError {
  return seamRejection(
    'astro:content entry source file',
    'fail-closed private',
    `a readable entry source file (${filePath})`,
    'a read rejection',
    cause,
  );
}
