import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, test } from '@playwright/test';
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
import {
  CID_FORM,
  CONTRACT_VERSION,
  type scopedStyleStrategy,
} from '../behavior-contracts/schema/inspection-contract.ts';

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

// derived from the schema's enum — the single home for the strategy union
export type CaptureStrategy = (typeof scopedStyleStrategy.options)[number];

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

/** One frozen fixture file: which oracle run produces it, and which captured leg it freezes. */
export interface CorpusManifestEntry {
  file: string;
  strategy: CaptureStrategy;
  leg: keyof InspectionCorpus;
}

/**
 * The corpus manifest — the SINGLE enumeration of the frozen fixture set
 * (#216): capture.mjs writes exactly these files, the freeze spec re-derives
 * exactly these files (per strategy), and the spec asserts agreement with
 * the schema registry's keys, so a fixture kind cannot be frozen without
 * also being re-frozen — a new kind that misses this list fails the spec,
 * never silently stops re-deriving.
 */
export const CORPUS_MANIFEST: readonly CorpusManifestEntry[] = [
  { file: 'css-index.attribute.json', strategy: 'attribute', leg: 'cssIndex' },
  { file: 'collections.json', strategy: 'attribute', leg: 'collections' },
  { file: 'content-schemas.json', strategy: 'attribute', leg: 'contentSchemas' },
  { file: 'raw-truth.json', strategy: 'attribute', leg: 'rawTruth' },
  { file: 'routes.json', strategy: 'attribute', leg: 'routes' },
  { file: 'route-resolution.json', strategy: 'attribute', leg: 'routeResolution' },
  { file: 'css-index.where.json', strategy: 'where', leg: 'cssIndex' },
];

/** Filename lookup over the attribute-strategy legs (the common case) — derived, never a second list. */
export const CORPUS_FILES = Object.fromEntries(
  CORPUS_MANIFEST.filter((entry) => entry.strategy === 'attribute').map((entry) => [
    entry.leg,
    entry.file,
  ]),
) as { [K in keyof InspectionCorpus]: string };

/**
 * Deterministic, diffable, repo-canonical bytes: two-space JSON through the
 * repo's own formatter (Biome, pinned version, config resolved from the
 * repo root both capture and spec run from), with a trailing newline. The
 * frozen corpus must be bytes `npm run check` accepts unchanged — hand-
 * rolled pretty-printing drifts from the formatter on short arrays.
 *
 * Regeneration rule: a Biome (or any formatter) version bump re-churns the
 * whole corpus as an unrelated diff — regenerate via
 * `node e2e/contract-oracle/capture.mjs` and expect a whole-corpus diff;
 * that is the documented trigger, not an accident. The freeze spec compares
 * frozen bytes against the same pinned formatter, so both sides move
 * together only when the pin itself moves.
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

/**
 * Whether the chromium executable Playwright resolves is actually installed.
 * The browserless check job of the no-E2E interval (ADR-0010, #283) has no
 * `playwright install` — the freeze tests skip on this probe there instead
 * of dying inside `chromium.launch()`, and auto-unskip once the CI companion
 * installs the browser (nothing here gates on a bespoke env var: the probe
 * reads Playwright's own registry path, so PLAYWRIGHT_BROWSERS_PATH and
 * every other real installation layout are honored). The full-chrome
 * executable is a faithful proxy for the headless shell `launch()` uses —
 * both entries carry the same registry revision and install together.
 */
export function chromiumExecutableExists(): boolean {
  return existsSync(chromium.executablePath());
}

/**
 * The one skip-guard every browser-needing contract test opens with — one
 * home so B2's capture suites copy one pattern, not a paste. Skip (with the
 * tracked prerequisite named, #285 — install chromium in the check job) when
 * the executable probe fails; call this as the first statement of the test
 * body, before any oracle prep or boot. The serverless legs of a suite
 * (schema validation, negatives) never call it and keep running everywhere.
 */
export function skipWithoutChromium(): void {
  test.skip(
    !chromiumExecutableExists(),
    'chromium not installed — CI browser install is the tracked prerequisite (#285)',
  );
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

/** Poll until a read satisfies `ready` — the deterministic settlement every capture leg settles through. */
export async function poll<T>(
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

export async function getJson<T>(baseUrl: string, path: string): Promise<T> {
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
      const expected = CID_FORM[strategy];
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
