import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
    const sources = await readProjectCssSources(root);
    expect(sources.map((source) => source.file)).toEqual([
      'src/components/nested/card.astro',
      'src/pages/home.css',
      'src/pages/index.astro',
    ]);
    expect(sources.map((source) => source.contents)).toEqual([
      '<style>.card { color: blue; }</style>',
      '.hero { display: grid; }',
      '<style>.a { color: red; }</style>',
    ]);
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
    expect(await readProjectCssSources(root)).toEqual([]);
  });
});

async function stageProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astroix-styles-join-sources-'));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), contents);
  }
  return root;
}
