import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEntryDraft } from '@wojciechpiskorz/astroix-core';
import type { AdapterErrorDetails } from '../adapter-error';
import { AdapterError } from '../adapter-error';

/**
 * The per-entry baseline read (#228): the entry source file's bytes —
 * the raw truth's anchor — read once per entry per pass, giving the
 * SHA-256 revision (ADR-0006 §6's exact baseline for existing
 * resources) and the raw frontmatter the project's actual schema
 * validates against (the same space Astro parses and safe-parses in its
 * content layer). Files are addressed ONLY through the project's own
 * served `filePath` (probed project-relative by `content-probes.ts`)
 * joined under the canonical project root — never a client-selected
 * path, never a directory walk.
 */

/** What one entry's source file yielded. */
export interface EntryBaseline {
  /** SHA-256 hex over the file's bytes — the resource revision / grant baseline. */
  readonly revision: string;
  /** The raw file parse; null when the frontmatter does not parse (mid-edit breakage). */
  readonly raw: { readonly data: unknown; readonly body: string } | null;
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
): Promise<EntryBaseline | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(projectRoot, filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw baselineRejection(filePath, error);
  }
  const raw = parseEntryDraft(bytes.toString('utf8'));
  return {
    revision: createHash('sha256').update(bytes).digest('hex'),
    raw: raw === null ? null : { data: raw.data, body: raw.body },
  };
}

function baselineRejection(filePath: string, cause: unknown): AdapterError {
  const details: AdapterErrorDetails = {
    seam: 'astro:content entry source file',
    seamClass: 'fail-closed private',
    expected: `a readable entry source file (${filePath})`,
    observed: 'a read rejection',
  };
  return new AdapterError(
    'seam-rejected',
    `AstroProjectAdapter seam rejection at ${details.seam}: expected ${details.expected}; observed ${details.observed}`,
    details,
    { cause },
  );
}
