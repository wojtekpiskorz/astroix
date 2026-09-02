import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readEntryBaseline } from '../../astro-project-adapter/content/entry-baselines';

/**
 * The per-entry baseline read (#228 focused tests): real temp files —
 * the SHA-256 revision over the bytes, the raw truth parse, the
 * sync-race absence, and the fail-closed wrap of broken reads.
 */

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })),
  );
});

async function stagedFile(contents: string): Promise<{ root: string; file: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-entry-baseline-')));
  scratch.push(root);
  const file = 'src/content/blog/post.md';
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), contents);
  return { root, file };
}

describe('readEntryBaseline', () => {
  it('returns the sha256 of the bytes and the raw truth parse', async () => {
    const contents = '---\ntitle: T\n---\n\nBody.\n';
    const { root, file } = await stagedFile(contents);
    const baseline = await readEntryBaseline(root, file);
    expect(baseline?.revision).toBe(createHash('sha256').update(contents).digest('hex'));
    expect(baseline?.raw).toEqual({ data: { title: 'T' }, body: 'Body.' });
  });

  it('returns a null raw parse (with the revision intact) for unparseable frontmatter', async () => {
    // Mid-edit breakage: the bytes anchor stays true, the raw truth is unreadable.
    const { root, file } = await stagedFile('---\ntitle: [unclosed\n---\n\nBody.\n');
    const baseline = await readEntryBaseline(root, file);
    expect(baseline?.raw).toBeNull();
    expect(typeof baseline?.revision).toBe('string');
  });

  it('reads a just-deleted file as null (the sync race)', async () => {
    const { root, file } = await stagedFile('---\n---\nx');
    await rm(join(root, file));
    expect(await readEntryBaseline(root, file)).toBeNull();
  });
});
