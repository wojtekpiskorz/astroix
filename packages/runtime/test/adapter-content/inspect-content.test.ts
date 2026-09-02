import { afterAll, describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import { inspectContent } from '../../astro-project-adapter/content/inspect-content';
import {
  corpusCollections,
  corpusSchemas,
  defaultModules,
  fakeComposition,
  fileDigest,
  isoSerialize,
  removeContentProjects,
  reproject,
  type StagedContentProject,
  stageContentProject,
  writeEntry,
} from './pass-harness';

/**
 * The #228 focused pass tests: collections/entries parity against the
 * frozen corpus, real-schema validation through the project's own zod,
 * fresh-runner closure on success and on schema failure, unsupported
 * loader/factory/shape negatives, and revision determinism — over the
 * fake composition harness (the real-runner truth is the #225
 * certification over the certified install).
 */

const scratch: StagedContentProject[] = [];

afterAll(async () => {
  await removeContentProjects(scratch.map((project) => project.root));
});

async function stagedPass() {
  const project = await stageContentProject();
  scratch.push(project);
  const composition = fakeComposition(project);
  composition.modules.clear();
  for (const [key, value] of defaultModules(project)) composition.modules.set(key, value);
  return { project, composition };
}

describe('inspectContent (the pass)', () => {
  it('returns collections and entries equal to the frozen corpus (rendered-data parity)', async () => {
    const { project, composition } = await stagedPass();
    const outcome = await inspectContent(composition);

    const corpus = await corpusCollections();
    expect(outcome.result.collections.map((collection) => collection.name)).toEqual(
      corpus.map((row) => row.name).sort(),
    );
    for (const row of corpus) {
      const collection = outcome.result.collections.find((c) => c.name === row.name);
      expect(collection, `collection ${row.name}`).toBeDefined();
      if (collection === undefined) continue;
      expect(collection.schema.declared).toBe(row.hasSchema);
      expect(
        collection.entries.map((entry) => ({
          id: entry.id,
          filePath: entry.filePath,
          data: isoSerialize(entry.data),
          body: entry.body,
        })),
      ).toEqual(row.entries);
      // Every file-backed entry carries its sha256 baseline; every valid
      // fixture entry of a schematized collection validates clean
      // through the project's real schema (schema-less collections
      // validate nothing — issues null).
      for (const entry of collection.entries) {
        if (entry.filePath === null) continue;
        expect(entry.revision).toBe(await fileDigest(project.root, entry.filePath));
        expect(entry.issues).toEqual(collection.schema.declared ? [] : null);
      }
    }
  });

  it('returns schema field walks equal to the frozen corpus (real schema behavior, not guessed metadata)', async () => {
    const { composition } = await stagedPass();
    const outcome = await inspectContent(composition);
    const schemas = await corpusSchemas();
    for (const row of schemas) {
      const collection = outcome.result.collections.find((c) => c.name === row.collection);
      expect(collection, `collection ${row.collection}`).toBeDefined();
      expect(collection?.schema.fields).toEqual(row.fields);
    }
  });

  it('uses one fresh runner per pass, closed with no residue, and closes it on a schema seam failure', async () => {
    const { composition } = await stagedPass();
    const first = await inspectContent(composition);
    expect(first.evidence).toEqual({
      sendListenersBefore: 0,
      sendListenersAfterClose: 0,
      closedAfterClose: true,
    });

    const second = await inspectContent(composition);
    expect(second.evidence.closedAfterClose).toBe(true);
    expect(composition.runners).toHaveLength(2);
    expect(composition.runners[0]?.closed).toBe(true);
    expect(composition.runners[1]?.closed).toBe(true);
    expect(composition.emitter.listenerCount('send')).toBe(0);

    // Pass-level schema failure: the config module's export drifted —
    // the pass rejects through the seam AND the runner still closed.
    const configId = [...composition.modules.keys()].find((id) => id.includes('content.config.ts'));
    expect(configId).toBeDefined();
    composition.modules.set(configId as string, { collections: 'drifted' });
    const rejection = await inspectContent(composition).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    expect((rejection as AdapterError).code).toBe('seam-rejected');
    expect((rejection as AdapterError).details).toMatchObject({
      seam: 'content config module src/content.config.ts collections export',
    });
    expect(composition.runners[2]?.closed).toBe(true);
    expect(composition.emitter.listenerCount('send')).toBe(0);
  });

  it('fails closed when the content config module does not evaluate at the certified path', async () => {
    const { composition } = await stagedPass();
    const configId = [...composition.modules.keys()].find((id) => id.includes('content.config.ts'));
    // Unmapping the id makes the fake runner's import reject — the pass
    // wraps it as the config seam's evaluation rejection, cause kept.
    composition.modules.delete(configId as string);
    const rejection = await inspectContent(composition).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('seam-rejected');
    expect(error.details).toMatchObject({
      seam: 'content config module src/content.config.ts collections export',
      observed: 'a module evaluation rejection',
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect(composition.runners.at(-1)?.closed).toBe(true);
  });

  it('fails closed when astro:content itself does not evaluate', async () => {
    const { composition } = await stagedPass();
    composition.modules.delete('astro:content');
    const rejection = await inspectContent(composition).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    expect((rejection as AdapterError).details).toMatchObject({
      seam: 'astro:content export getCollection()',
      observed: 'a module evaluation rejection',
    });
    expect(composition.runners.at(-1)?.closed).toBe(true);
    expect(composition.emitter.listenerCount('send')).toBe(0);
  });

  it('diagnoses unknown loaders, legacy shapes, and unsupported schemas per collection — the rest stays certified', async () => {
    const { project, composition } = await stagedPass();
    const collections = project.collections as Record<
      string,
      { type?: unknown; loader?: unknown; schema?: unknown }
    >;
    collections.api = {
      type: 'content_layer',
      loader: { name: 'http-loader', load: async () => {} },
    };
    collections.legacy = { type: 'content', schema: { stale: true } };
    collections.liveloader = { type: 'content_layer', loader: async () => {} };
    collections.badfactory = {
      type: 'content_layer',
      loader: { name: 'glob-loader', load: async () => {} },
      schema: () => {
        throw new Error('factory boom');
      },
    };
    collections.notzod = {
      type: 'content_layer',
      loader: { name: 'glob-loader', load: async () => {} },
      schema: { pretend: true },
    };

    const outcome = await inspectContent(composition);
    expect(outcome.result.collections.map((c) => c.name)).toEqual([
      'blog',
      'gallery',
      'homepage',
      'notes',
    ]);
    expect(outcome.result.diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown-loader', collection: 'api' }),
      expect.objectContaining({ code: 'unknown-schema-factory', collection: 'badfactory' }),
      expect.objectContaining({ code: 'unsupported-collection-shape', collection: 'legacy' }),
      expect.objectContaining({ code: 'unknown-loader', collection: 'liveloader' }),
      expect.objectContaining({ code: 'unknown-schema-shape', collection: 'notzod' }),
    ]);
    for (const diagnostic of outcome.result.diagnostics) {
      expect(typeof diagnostic.expected).toBe('string');
      expect(diagnostic.observed).not.toContain(project.root);
    }
    // The unsupported-schema pass still closed its runner.
    expect(outcome.evidence.closedAfterClose).toBe(true);
  });

  it('diagnoses a schema factory that returns a non-zod schema', async () => {
    const { project, composition } = await stagedPass();
    (project.collections as Record<string, unknown>).odd = {
      type: 'content_layer',
      loader: { name: 'glob-loader', load: async () => {} },
      schema: () => 42,
    };
    const outcome = await inspectContent(composition);
    expect(outcome.result.diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown-schema-factory', collection: 'odd' }),
    ]);
  });

  it('validates entries through the project actual schema and surfaces its real issue records', async () => {
    const { project, composition } = await stagedPass();
    await writeEntry(
      project,
      'src/content/blog/invalid.md',
      '---\ndate: 2026-01-01\ntags: [x]\n---\n\nBroken post: no title.\n',
    );
    await writeEntry(
      project,
      'src/content/homepage/broken-cta.md',
      '---\ntitle: T\nlead: L\ncta:\n  href: /x\n---\n\nNested miss.\n',
    );
    project.store.set('blog', await reproject(project.root, project.collections, 'blog'));
    project.store.set('homepage', await reproject(project.root, project.collections, 'homepage'));
    // The store serves the raw frontmatter parse for schema-failing
    // entries (astro would surface the sync error; the pass's job is the
    // issue records against the CURRENT schema instance).
    const outcome = await inspectContent(composition);
    const blog = outcome.result.collections.find((c) => c.name === 'blog');
    const invalid = blog?.entries.find((entry) => entry.id === 'invalid');
    expect(invalid?.issues?.map((issue) => issue.path)).toEqual(['title']);
    expect(invalid?.issues?.[0]?.code).toBe('invalid_type');
    expect(typeof invalid?.issues?.[0]?.message).toBe('string');

    const homepage = outcome.result.collections.find((c) => c.name === 'homepage');
    const brokenCta = homepage?.entries.find((entry) => entry.id === 'broken-cta');
    expect(brokenCta?.issues?.map((issue) => issue.path)).toEqual(['cta.label']);
  });

  it('serves null revisions and issues for store entries without a file, and for sync-race deletions', async () => {
    const { project, composition } = await stagedPass();
    // A store entry without a file is served with filePath absent (astro's
    // shape) — the pass reports it without a baseline.
    project.store.set('notes', [{ id: 'virtual', data: { title: 'Virtual' }, body: null }]);
    // The sync race: the store still serves the entry whose file just
    // disappeared — the entry keeps its projection, loses its baseline.
    const servedHomepage = project.store.get('homepage') ?? [];
    const { rm } = await import('node:fs/promises');
    await rm(`${project.root}/src/content/homepage/index.md`);
    project.store.set('homepage', servedHomepage);

    const outcome = await inspectContent(composition);
    const notes = outcome.result.collections.find((c) => c.name === 'notes');
    expect(notes?.entries).toEqual([
      {
        id: 'virtual',
        filePath: null,
        data: { title: 'Virtual' },
        body: null,
        revision: null,
        issues: null,
      },
    ]);
    const homepage = outcome.result.collections.find((c) => c.name === 'homepage');
    expect(homepage?.entries.map((entry) => [entry.id, entry.revision, entry.issues])).toEqual([
      ['index', null, null],
    ]);
  });

  it('keeps revisions deterministic across passes and sensitive to file and schema truth', async () => {
    const { project, composition } = await stagedPass();
    const first = await inspectContent(composition);
    const second = await inspectContent(composition);
    expect(second.result.revision).toBe(first.result.revision);
    expect(second.result.collections.map((collection) => collection.revision)).toEqual(
      first.result.collections.map((collection) => collection.revision),
    );

    // File change: entry revision, collection revision, and pass revision all move.
    await writeEntry(
      project,
      'src/content/notes/changed.md',
      '---\nkind: changed\n---\n\nEdited.\n',
    );
    project.store.set('notes', await reproject(project.root, project.collections, 'notes'));
    const third = await inspectContent(composition);
    const notes = third.result.collections.find((c) => c.name === 'notes');
    expect(notes?.entries.map((entry) => entry.id)).toEqual(['changed', 'index', 'scratch']);
    expect(third.result.revision).not.toBe(first.result.revision);
    expect(third.result.collections.find((c) => c.name === 'notes')?.revision).not.toBe(
      first.result.collections.find((c) => c.name === 'notes')?.revision,
    );
    // Untouched collections keep their revisions.
    expect(third.result.collections.find((c) => c.name === 'blog')?.revision).toBe(
      first.result.collections.find((c) => c.name === 'blog')?.revision,
    );
  });

  it('probes the entry serving shape and rejects drift fail-closed', async () => {
    const { project, composition } = await stagedPass();
    project.store.set('notes', [{ id: 'bad', filePath: '/etc/passwd', data: {}, body: null }]);
    const rejection = await inspectContent(composition).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    expect((rejection as AdapterError).details).toMatchObject({
      seam: 'astro:content getCollection() entry export',
    });

    project.store.set('notes', [{ id: 'bad', data: [] }]);
    const arrayData = await inspectContent(composition).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((arrayData as AdapterError)?.code).toBe('seam-rejected');
  });

  it('wraps a getCollection rejection for a declared collection as the public seam', async () => {
    const { project, composition } = await stagedPass();
    const collections = project.collections as Record<string, unknown>;
    collections.boom = {
      type: 'content_layer',
      loader: { name: 'glob-loader', load: async () => {} },
    };
    composition.modules.set('astro:content', {
      getCollection: async (name: string) => {
        if (name === 'boom') throw new Error('store exploded');
        return project.store.get(name) ?? [];
      },
    });
    const rejection = await inspectContent(composition).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('seam-rejected');
    expect(error.details).toMatchObject({
      seam: 'astro:content export getCollection()',
      observed: 'a getCollection rejection',
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect(composition.runners.at(-1)?.closed).toBe(true);
  });
});
