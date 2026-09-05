import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import { readProjectCssSources } from '../../astro-project-adapter/styles/join/project-css-sources';

/**
 * The styles join's static-truth reader (#226 focused tests): a
 * deterministic real-filesystem walk (temp directories) yielding
 * project-relative posix paths, skipping `node_modules` and dot
 * entries — and failing closed, sanitized, when the project source
 * directory is absent.
 *
 * The walk's per-file digests (#405) are proven over the SAME real
 * bytes: each published digest is the SHA-256 of the file's exact
 * contents on disk — the indexed truth's own hash, keyed by the same
 * project-relative posix path the records carry, and moving exactly
 * when the bytes move (same-length drift included).
 */

describe('readProjectCssSources', () => {
  it('walks the source tree deterministically with project-relative posix paths', async () => {
    const root = await stageProject({
      'src/pages/index.astro': '<style>.a { color: red; }</style>',
      'src/pages/home.css': '.hero { display: grid; }',
      'src/components/nested/card.astro': '<style>.card { color: blue; }</style>',
      'src/ignored.txt': 'not a style source',
      'src/.hidden/style.css': '.hidden { color: gray; }',
      'src/node_modules/pkg/pkg.css': '.pkg { color: pink; }',
      'README.md': 'outside the source tree',
    });
    const walk = await readProjectCssSources(root);
    expect(walk.sources.map((source) => source.file)).toEqual([
      'src/components/nested/card.astro',
      'src/pages/home.css',
      'src/pages/index.astro',
    ]);
    expect(walk.sources.map((source) => source.contents)).toEqual([
      '<style>.card { color: blue; }</style>',
      '.hero { display: grid; }',
      '<style>.a { color: red; }</style>',
    ]);
  });

  it('publishes a per-file digest over the exact bytes on disk, keyed by the walk path (#405)', async () => {
    const root = await stageProject({
      'src/pages/index.astro': '<style>.a { color: red; }</style>',
      'src/pages/home.css': '.hero { display: grid; }',
    });
    const walk = await readProjectCssSources(root);
    // The digest of every WALKED file, over the file's real bytes — the
    // same key the records carry, the same value a later re-read hashes.
    expect(Object.keys(walk.fileDigests).sort()).toEqual([
      'src/pages/home.css',
      'src/pages/index.astro',
    ]);
    for (const file of Object.keys(walk.fileDigests)) {
      expect(walk.fileDigests[file]).toBe(sha256(await readFile(join(root, file))));
    }
    // Contents and digests come from ONE read: the utf-8 string decodes
    // from exactly the digested bytes.
    const sheet = walk.sources.find((source) => source.file === 'src/pages/home.css');
    expect(sha256(Buffer.from(sheet?.contents ?? '', 'utf8'))).toBe(
      walk.fileDigests['src/pages/home.css'],
    );
  });

  it('moves the digest when the bytes move — same-length drift included (#405)', async () => {
    const root = await stageProject({ 'src/pages/home.css': '.hero { color: #1e293b; }' });
    const before = await readProjectCssSources(root);
    // Same length, different bytes: the exact drift shape the length-fit
    // coherence gate could not see — the digest must.
    await writeFile(join(root, 'src/pages/home.css'), '.hero { color: #0e193b; }');
    const after = await readProjectCssSources(root);
    expect(after.sources[0]?.contents).toHaveLength(before.sources[0]?.contents.length ?? -1);
    expect(after.fileDigests['src/pages/home.css']).not.toBe(
      before.fileDigests['src/pages/home.css'],
    );
  });

  it('fails closed, sanitized, when the project has no source directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'astroix-styles-join-sources-'));
    const rejection = await readProjectCssSources(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('seam-rejected');
    expect(error.details).toMatchObject({
      seam: 'styles join project CSS source walk',
      seamClass: 'fail-closed private',
      expected: 'a readable project source directory',
      observed: 'an absent or unreadable project source directory',
    });
    // Output hygiene: the diagnostic never names the root (ADR-0006 §7).
    expect(error.message).not.toContain(root);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('reads a source tree with no style sources as no sources (not a rejection)', async () => {
    const root = await stageProject({ 'src/pages/about.html': '<p>not a style source</p>' });
    expect(await readProjectCssSources(root)).toEqual({ sources: [], fileDigests: {} });
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function stageProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astroix-styles-join-sources-'));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), contents);
  }
  return root;
}
