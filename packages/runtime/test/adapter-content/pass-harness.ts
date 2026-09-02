import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEntryDraft } from '@wojciechpiskorz/astroix-core';
import { z } from 'zod';
import type { CompositionServer } from '../../astro-project-adapter/composition';

/**
 * The #228 unit harness: a fake composition server + fresh-runner
 * stand-ins (the `fresh-runner.test.ts` idiom — the ACCOUNTING is real,
 * the Vite runner behind it is faked; the real-runner behavior is the
 * #225 certification's truth over the certified install) over a
 * disposable temp copy of the canonical fixture's content tree. The
 * served store entries are the REAL zod projections for the
 * instance-schema collections (`parseEntryDraft` + `safeParseAsync`
 * through the mirror config — the pipeline astro's content layer runs),
 * so rendered-data parity against the frozen corpus is proved with the
 * project's actual schema behavior, not hand-written rows. The gallery
 * projection comes verbatim from the frozen corpus: astro's `image()`
 * asset resolution is the certified store's truth, not something the
 * unit tier rebuilds.
 */

const FIXTURE_CONTENT = join(process.cwd(), 'e2e', 'fixture', 'src', 'content');
const CORPUS_DIR = join(process.cwd(), 'e2e', 'behavior-contracts', 'inspection');

/** A module whose evaluation the fake runner rejects. */
export const FAIL_EVALUATION = Symbol('astroix-harness-fail-evaluation');

/** The mirror of the fixture's `src/content.config.ts`, built with the workspace zod. */
export function mirrorCollections(): Record<string, unknown> {
  const globLoader = { name: 'glob-loader', load: async () => {} };
  return {
    homepage: {
      type: 'content_layer',
      loader: globLoader,
      schema: z.object({
        title: z.string(),
        lead: z.string(),
        image: z.string().optional(),
        cta: z
          .object({
            label: z.string(),
            href: z.string(),
          })
          .optional(),
      }),
    },
    blog: {
      type: 'content_layer',
      loader: globLoader,
      schema: z.object({
        title: z.string().min(3),
        date: z.coerce.date(),
        tags: z.array(z.string()).default([]),
        tone: z.enum(['bold', 'calm']).default('bold'),
        priority: z.number().default(0),
        featured: z.boolean().default(false),
        meta: z
          .object({
            source: z.string().optional(),
          })
          .optional(),
        aside: z.union([z.string(), z.number()]).optional(),
      }),
    },
    notes: { type: 'content_layer', loader: globLoader },
    gallery: {
      type: 'content_layer',
      loader: globLoader,
      schema: ({ image }: { image: () => unknown }) =>
        z.object({
          hero: image(),
          alt: z.string(),
        }),
    },
  };
}

/** The frozen corpus's gallery projection — astro's image() metadata, byte-frozen in B1. */
const GALLERY_PROJECTION = {
  hero: {
    src: '/src/assets/pixel.png?origWidth=1&origHeight=1&origFormat=png',
    width: 1,
    height: 1,
    format: 'png',
  },
  alt: 'A single pixel',
};

/** The instance-schema collections the harness reprojects from file truth. */
const REPROJECTED: ReadonlyArray<{ readonly name: 'blog' | 'homepage' | 'notes' }> = [
  { name: 'blog' },
  { name: 'homepage' },
  { name: 'notes' },
];

/**
 * A store entry as the fake store holds it: pre-probe astro shape —
 * `filePath` and `body` may be absent exactly as the content layer
 * serves them; the pass's probes own the certified validation.
 */
export interface StoreEntry {
  readonly id: string;
  readonly filePath?: string;
  readonly data: unknown;
  readonly body?: string | null;
}

export interface StagedContentProject {
  readonly root: string;
  readonly store: Map<string, StoreEntry[]>;
  readonly collections: Record<string, unknown>;
}

/** Stages the temp managed project: the fixture's content tree + the served store. */
export async function stageContentProject(): Promise<StagedContentProject> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-content-pass-')));
  await copyTree(FIXTURE_CONTENT, join(root, 'src', 'content'));
  const collections = mirrorCollections();
  const store = new Map<string, StoreEntry[]>();
  for (const { name } of REPROJECTED) {
    store.set(name, await reproject(root, collections, name));
  }
  const draft = parseEntryDraft(
    await readFile(join(root, 'src/content/gallery/showcase.md'), 'utf8'),
  );
  if (draft === null) throw new Error('harness: the fixture gallery entry does not parse');
  store.set('gallery', [
    {
      id: 'showcase',
      filePath: 'src/content/gallery/showcase.md',
      data: GALLERY_PROJECTION,
      body: draft.body,
    },
  ]);
  return { root, store, collections };
}

/** Rebuilds one served collection from current file truth (mutation-oriented setup). */
export async function reproject(
  root: string,
  collections: Record<string, unknown>,
  name: 'blog' | 'homepage' | 'notes',
): Promise<StoreEntry[]> {
  const schema = (collections[name] as { schema?: unknown }).schema ?? null;
  const files = await listMarkdownFiles(join(root, 'src', 'content', name));
  const entries: StoreEntry[] = [];
  for (const relative of files) {
    const filePath = `src/content/${name}/${relative}`;
    const contents = await readFile(join(root, filePath), 'utf8');
    const draft = parseEntryDraft(contents);
    if (draft === null) throw new Error(`harness: ${filePath} does not parse`);
    // A schema-failing entry serves its raw frontmatter parse — the
    // schema-drift-after-sync shape the pass's validation path owns.
    const parsed =
      schema === null
        ? null
        : await (
            schema as { safeParseAsync(d: unknown): Promise<{ success: boolean; data?: unknown }> }
          ).safeParseAsync(draft.data);
    const data = parsed === null || !parsed.success ? draft.data : parsed.data;
    // The glob loader's id: the path under the collection dir, extension dropped.
    entries.push({ id: relative.replace(/\.md$/, ''), filePath, data, body: draft.body });
  }
  return entries;
}

/** Posix-relative .md paths under a directory, code-unit sorted (recursive — nested ids). */
async function listMarkdownFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      found.push(...(await listMarkdownFiles(join(dir, entry.name), relative)));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(relative);
  }
  return found;
}

/** The sha256 of a file's bytes — the expected entry revision, computed independently. */
export async function fileDigest(root: string, filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(join(root, filePath)))
    .digest('hex');
}

// ——— the fake composition + runner (the fresh-runner.test.ts idiom) ———

/**
 * A fake runner mirroring the real pin discipline: construction pins
 * `send` listeners on the SSR hot transport; `close()` removes exactly
 * those and flips closed. Imports answer from the shared module map.
 */
export class FakePassRunner {
  closed = false;
  private readonly pinned: Array<() => void> = [];

  constructor(
    private readonly modules: Map<string, unknown>,
    private readonly emitter: EventEmitter,
    runners?: FakePassRunner[],
  ) {
    for (let i = 0; i < 3; i += 1) {
      const listener = (): void => {};
      this.pinned.push(listener);
      this.emitter.on('send', listener);
    }
    runners?.push(this);
  }

  async import(id: string): Promise<unknown> {
    const mapped = this.modules.get(id);
    if (mapped === FAIL_EVALUATION) throw new Error(`harness: ${id} fails to evaluate`);
    if (mapped === undefined) throw new Error(`harness: no module mapped for ${id}`);
    return mapped;
  }

  async close(): Promise<void> {
    for (const listener of this.pinned) this.emitter.removeListener('send', listener);
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export interface FakeComposition extends CompositionServer {
  readonly runners: readonly FakePassRunner[];
  readonly emitter: EventEmitter;
  readonly modules: Map<string, unknown>;
}

/** The composition stand-in — live only on the surfaces the content pass touches. */
export function fakeComposition(project: StagedContentProject): FakeComposition {
  const emitter = new EventEmitter();
  const runners: FakePassRunner[] = [];
  const modules = new Map<string, unknown>();
  const inertServer = {
    environments: {
      ssr: {
        moduleGraph: { getModuleById: () => null, getModuleByUrl: () => null },
        pluginContainer: { resolveId: async () => null },
        hot: { api: { outsideEmitter: emitter } },
      },
      client: {},
    },
    watcher: { on: () => ({}) },
    close: async () => {},
  };
  const composition: FakeComposition = {
    runners,
    emitter,
    modules,
    seams: {
      certifiedPair: { astro: '7.2.10', vite: '8.2.2' },
      projectRoot: project.root,
      getViteConfig: () => async () => ({}),
      getDevCSSModuleName: (id: string) => `virtual:astro:dev-css:${id}`,
      vite: {
        createServer: async () => inertServer,
        createServerModuleRunner: () => new FakePassRunner(modules, emitter, runners),
      },
    },
    server: inertServer,
    close: async () => {},
  };
  return composition;
}

/** The default module map: the project's config, store, and the project zod namespace. */
export function defaultModules(project: StagedContentProject): Map<string, unknown> {
  const modules = new Map<string, unknown>();
  modules.set('astro:content', {
    getCollection: async (name: string) => project.store.get(name) ?? [],
  });
  modules.set(pathToFileURL(join(project.root, 'src', 'content.config.ts')).href, {
    collections: project.collections,
  });
  modules.set('astro/zod', z);
  return modules;
}

/** The corpus row shape, as frozen (the parity oracle). */
interface CorpusEntryRow {
  id: string;
  filePath: string | null;
  data: unknown;
  body: string | null;
}

export async function corpusCollections(): Promise<
  Array<{ name: string; hasSchema: boolean; entries: CorpusEntryRow[] }>
> {
  const corpus = JSON.parse(await readFile(join(CORPUS_DIR, 'collections.json'), 'utf8')) as {
    collections: Array<{ name: string; hasSchema: boolean; entries: CorpusEntryRow[] }>;
  };
  return corpus.collections;
}

export async function corpusSchemas(): Promise<Array<{ collection: string; fields: unknown[] }>> {
  const corpus = JSON.parse(await readFile(join(CORPUS_DIR, 'content-schemas.json'), 'utf8')) as {
    schemas: Array<{ collection: string; fields: unknown[] }>;
  };
  return corpus.schemas;
}

/** ISO-serializes a projection the way the corpus froze it (dates as ISO strings). */
export function isoSerialize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) =>
      inner instanceof Date ? inner.toISOString() : inner,
    ),
  );
}

/** Writes a content entry file into the staged project. */
export async function writeEntry(
  project: StagedContentProject,
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(join(project.root, dirname(filePath)), { recursive: true });
  await writeFile(join(project.root, filePath), contents);
}

/** Cleanup for staged projects. */
export async function removeContentProjects(roots: readonly string[]): Promise<void> {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}
