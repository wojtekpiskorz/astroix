import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import {
  readConfigBaseline,
  readEntryBaseline,
} from '../../astro-project-adapter/content/entry-baselines';

/**
 * The per-entry and per-config baseline reads (#228 focused tests):
 * real temp files — the SHA-256 revisions over the bytes, the raw truth
 * parse, the sync-race absence, and the fail-closed wrap of broken
 * reads (a directory in the entry's path covers the non-ENOENT branch).
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

  it('fails closed on other read failures instead of reading them as absence', async () => {
    // A directory where the entry file should be: EISDIR — the
    // non-ENOENT branch wraps as the entry-source seam, cause kept.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-entry-baseline-')));
    scratch.push(root);
    await mkdir(join(root, 'src/content/blog'), { recursive: true });
    const rejection = await readEntryBaseline(root, 'src/content/blog').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('seam-rejected');
    expect(error.details).toMatchObject({
      seam: 'astro:content entry source file',
      observed: 'a read rejection',
    });
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('readConfigBaseline', () => {
  it('returns the sha256 of the config module bytes', async () => {
    const contents = 'export const collections = {};\n';
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-config-baseline-')));
    scratch.push(root);
    await mkdir(dirname(join(root, 'src/content.config.ts')), { recursive: true });
    await writeFile(join(root, 'src/content.config.ts'), contents);
    expect(await readConfigBaseline(root)).toBe(
      createHash('sha256').update(contents).digest('hex'),
    );
  });

  it('fails closed when the config module is unreadable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-config-baseline-')));
    scratch.push(root);
    const rejection = await readConfigBaseline(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    expect((rejection as AdapterError).details).toMatchObject({
      seam: 'content config module src/content.config.ts collections export',
      observed: 'a read rejection',
    });
  });
});
