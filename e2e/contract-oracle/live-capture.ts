import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  type CollectionsIndex,
  hasCandidateRoutes,
  pickNavigableCandidate,
  resolveActiveEntry,
} from '../../packages/core/src/route-resolver.ts';
import type {
  CollectionsFixture,
  ContentSchemasFixture,
  CssIndexFixture,
  RawTruthFixture,
  RouteResolutionFixture,
  RoutesFixture,
} from '../behavior-contracts/schema/inspection-contract.ts';
import { CONTRACT_VERSION } from '../behavior-contracts/schema/inspection-contract.ts';

/**
 * The live inspection capture (#216, lane B1): drives a booted disposable
 * oracle honestly — a real Chromium document load (the scoped style module
 * enters the client module graph only when a browser fetches it), then the
 * real `/__astroix` inspection endpoints — computes route resolution with
 * the extracted pure core module over the captured payloads, scrubs the one
 * observed absolute-path leak (astro's `image()` zod projection), and
 * serializes deterministically. Both the frozen corpus writer
 * (capture.mjs) and the freeze-proof spec call this same module, so the
 * comparison is over one pipeline, never two.
 */

export type CaptureStrategy = 'attribute' | 'where';

export interface CaptureOptions {
  /** The booted oracle's base URL (http://localhost:<port>). */
  base: string;
  /** The oracle copy's absolute root — the scrub's relativization anchor. */
  root: string;
  strategy: CaptureStrategy;
}

export interface InspectionCorpus {
  cssIndex: CssIndexFixture;
  collections: CollectionsFixture;
  contentSchemas: ContentSchemasFixture;
  rawTruth: RawTruthFixture;
  routes: RoutesFixture;
  routeResolution: RouteResolutionFixture;
}

/** The corpus fixture file each captured envelope freezes into. */
export const CORPUS_FILES = {
  cssIndex: 'css-index.attribute.json',
  collections: 'collections.json',
  contentSchemas: 'content-schemas.json',
  rawTruth: 'raw-truth.json',
  routes: 'routes.json',
  routeResolution: 'route-resolution.json',
} as const;

/**
 * Deterministic, diffable, repo-canonical bytes: two-space JSON through the
 * repo's own formatter (Biome, pinned version, config resolved from the
 * repo root both capture and spec run from), with a trailing newline. The
 * frozen corpus must be bytes `npm run check` accepts unchanged — hand-
 * rolled pretty-printing drifts from the formatter on short arrays.
 */
export function serializeFixture(value: unknown): string {
  const raw = JSON.stringify(value, null, 2);
  const result = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'biome'),
    ['format', '--stdin-file-path=fixture.json'],
    { input: raw, encoding: 'utf8' },
  );
  if (result.error !== undefined || result.status !== 0 || result.stdout === null) {
    throw new Error(`biome format failed over captured bytes: ${String(result.stderr)}`);
  }
  return result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`;
}

/** The raw-truth reads the corpus pins: the zod-defaults gap and the schema-less passthrough. */
const RAW_TRUTH_TARGETS: ReadonlyArray<{ collection: string; id: string }> = [
  { collection: 'blog', id: 'hello-builder' },
  { collection: 'notes', id: 'scratch' },
];

/** The canvas URLs the corpus probes: rendered entries, the static page, and the unknown-route states. */
const URL_PROBES: readonly string[] = [
  '/',
  '/blog/hello-builder',
  '/blog/2024/post',
  '/blog/2025/release-notes',
  '/blog/nonexistent',
  '/does-not-exist',
];

const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll<T>(
  description: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`capture never became ready: ${description}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Relativize astro's `image()` projection: `/@fs<oracle-root>/src/...` → `/src/...`. */
function scrubAbsolutePaths<T>(value: T, root: string): T {
  const scrub = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const prefix = `/@fs${root}`;
      return node.startsWith(prefix) ? node.slice(prefix.length) : node;
    }
    if (Array.isArray(node)) return node.map((item) => scrub(item));
    if (typeof node === 'object' && node !== null) {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) scrubbed[key] = scrub(item);
      return scrubbed;
    }
    return node;
  };
  return scrub(value) as T;
}

/**
 * AC-4 hygiene gate over serialized fixture text: no absolute paths, ports,
 * timestamps, Vite handles, browser object references, or package-staging
 * artifacts survive into the frozen corpus. Runs at capture time (unknown
 * leakage fails the capture) and in the spec (over the frozen files).
 */
export function assertNoForbiddenArtifacts(text: string, label: string): void {
  const offenders: string[] = [];
  const forbid = (pattern: RegExp, what: string): void => {
    const match = text.match(pattern);
    if (match !== null) offenders.push(`${what}: ${JSON.stringify(match[0])}`);
  };
  forbid(/\/(?:Users|home|private|tmp|var)\//, 'absolute path');
  forbid(/\/@fs\//, 'vite /@fs absolute-path handle');
  forbid(/\blocalhost\b|\b127\.0\.0\.1\b|:\d{4,5}\b/, 'host or port');
  forbid(/\b1[6-9]\d{11}\b/, 'epoch-millisecond timestamp');
  forbid(/\\u0000|\?\bv=\d|&t=\d|\?t=\d|\/@id\/|import\.meta\.hot|\.vite\//, 'vite handle');
  forbid(
    /\.astroix-local|\.oracle-fixture|\.oracle-pack|\.oracle-src|\.oracle-where|astroix-e2e-oracle/,
    'package-staging artifact',
  );
  if (offenders.length > 0) {
    throw new Error(`${label} carries forbidden artifacts — ${offenders.join('; ')}`);
  }
}

/** Envelope stamp shared by every capture builder. */
function envelope<K extends string, T extends object>(
  kind: K,
  data: T,
): T & { contractVersion: string; kind: K } {
  return { contractVersion: CONTRACT_VERSION, kind, ...data };
}

/** Capture the whole inspection corpus from one booted oracle. */
export async function captureInspectionCorpus(options: CaptureOptions): Promise<InspectionCorpus> {
  const { base, root, strategy } = options;
  const browser = await chromium.launch();
  try {
    // A real document load first: the scoped style module enters the client
    // module graph only once a browser has requested it (cold graph → null,
    // by design), and the chrome's canvas iframe triggers exactly that.
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'load' });

    const cssIndex = await poll(
      'index payload with joined scoped selectors',
      () => getJson<CssIndexFixture['records']>(base, '/__astroix/index'),
      (records) =>
        records.some((record) => record.scoped) &&
        records
          .filter((record) => record.scoped)
          .every((record) => record.effectiveSelector !== null),
    );
    // Honest-capture guard: a where run that silently fell back to the
    // attribute strategy would freeze the wrong selector form. Observed on
    // the certified pair: attribute → `[data-astro-cid-<hash>]`, where →
    // `:where(.astro-<hash>)` (the scoped class, same path-derived hash).
    for (const record of cssIndex) {
      if (!record.scoped || record.effectiveSelector === null) continue;
      const expected = strategy === 'where' ? ':where(.astro-' : '[data-astro-cid-';
      if (!record.effectiveSelector.includes(expected)) {
        throw new Error(
          `scoped effective selector ${record.effectiveSelector} does not carry the ${strategy} strategy's cid form`,
        );
      }
    }

    const routes = await poll(
      'routes payload with the getStaticPaths enumeration landed',
      () => getJson<RoutesFixture['routes']>(base, '/__astroix/routes'),
      (payload) =>
        payload.every(
          (route) =>
            !(route.params.length === 1 && route.rendering === 'prerendered') ||
            route.renders !== undefined,
        ),
    );

    const collectionsRaw = await poll(
      'collections payload fully synced',
      () => getJson<CollectionsFixture['collections']>(base, '/__astroix/collections'),
      (payload) => payload.find((collection) => collection.name === 'blog')?.entries.length === 3,
    );
    const collections = scrubAbsolutePaths(collectionsRaw, root);

    const schemas: ContentSchemasFixture['schemas'] = [];
    for (const collection of collections) {
      schemas.push(
        await getJson<ContentSchemasFixture['schemas'][number]>(
          base,
          `/__astroix/content-schema?collection=${encodeURIComponent(collection.name)}`,
        ),
      );
    }

    const reads: RawTruthFixture['reads'] = [];
    for (const target of RAW_TRUTH_TARGETS) {
      const entry = collections
        .find((collection) => collection.name === target.collection)
        ?.entries.find((candidate) => candidate.id === target.id);
      if (entry?.filePath == null) {
        throw new Error(
          `raw-truth target ${target.collection}/${target.id} missing from the payload`,
        );
      }
      reads.push(
        await getJson<RawTruthFixture['reads'][number]>(
          base,
          `/__astroix/file?file=${encodeURIComponent(entry.filePath)}`,
        ),
      );
    }

    // Route resolution — the pure core module over the captured payloads.
    const collectionsIndex: CollectionsIndex = Object.fromEntries(
      collections.map((collection) => [
        collection.name,
        collection.entries.map((entry) => entry.id),
      ]),
    );
    const seen = new Set<string>();
    const entryResolutions: RouteResolutionFixture['entryResolutions'] = [];
    for (const collection of collections) {
      for (const entry of collection.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const holders = Object.keys(collectionsIndex).filter((name) =>
          (collectionsIndex[name] ?? []).includes(entry.id),
        );
        const hasCandidates = hasCandidateRoutes(entry.id, routes);
        entryResolutions.push({
          entryId: entry.id,
          holderCollections: holders,
          candidateUrl: pickNavigableCandidate(entry.id, routes, collectionsIndex),
          hasCandidateRoutes: hasCandidates,
          unrouted: !hasCandidates,
        });
      }
    }

    const urlProbes: RouteResolutionFixture['urlProbes'] = [];
    for (const url of URL_PROBES) {
      const response = await fetch(`${base}${url}`);
      if (response.status !== 200 && response.status !== 404) {
        throw new Error(
          `probe ${url} answered HTTP ${response.status} — outside the frozen 200/404 rendering states`,
        );
      }
      urlProbes.push({
        url,
        httpStatus: response.status as 200 | 404,
        resolved: resolveActiveEntry(routes, url, collectionsIndex),
      });
    }

    await page.close();
    return {
      cssIndex: envelope('css-index', { scopedStyleStrategy: strategy, records: cssIndex }),
      collections: envelope('collections', { collections }),
      contentSchemas: envelope('content-schemas', { schemas }),
      rawTruth: envelope('raw-truth', { reads }),
      routes: envelope('routes', { routes }),
      routeResolution: envelope('route-resolution', { entryResolutions, urlProbes }),
    };
  } finally {
    await browser.close();
  }
}
